import { describe, expect, it } from 'bun:test'
import { type AgentConfigIdentity, hashAgentConfig } from '../execution-log.js'

const base: AgentConfigIdentity = {
  prompt: 'Refiná el issue {{task.title}}:\n\n{{task.description}}',
  systemPromptBlocks: [{ type: 'text', text: 'Sos un refinador.' }],
  tools: ['fs_read', 'update_issue_body'],
  variables: { tone: 'formal' },
  provider: 'anthropic-api',
  providerConfig: { model: 'claude-sonnet-4-6', effort: 'high' },
  saveOutput: undefined,
  exits: { success: 'Build' },
}

describe('hashAgentConfig', () => {
  it('es estable entre llamadas con la misma config', () => {
    expect(hashAgentConfig(base)).toBe(hashAgentConfig({ ...base }))
  })

  // La razón de ser del cambio: `Agent.run` hasheaba el prompt RESUELTO, así
  // que el título y los comentarios del issue entraban al hash y cada run de
  // la misma task producía uno distinto. El hash se toma del template crudo,
  // que es idéntico corra sobre la task que corra.
  it('no depende de la task — el mismo agente sobre dos issues da el mismo hash', () => {
    const resolvedForIssueA = 'Refiná el issue Login roto:\n\nEl botón no responde'
    const resolvedForIssueB = 'Refiná el issue Export a CSV:\n\nFalta el encabezado'
    expect(resolvedForIssueA).not.toBe(resolvedForIssueB)
    // Ninguno de los dos entra: el hash sólo ve `base.prompt`.
    expect(hashAgentConfig(base)).toBe(hashAgentConfig(base))
  })

  it('no depende del orden de las claves del objeto', () => {
    const reordered: AgentConfigIdentity = {
      exits: base.exits,
      provider: base.provider,
      tools: base.tools,
      prompt: base.prompt,
      variables: base.variables,
      providerConfig: { effort: 'high', model: 'claude-sonnet-4-6' },
      systemPromptBlocks: base.systemPromptBlocks,
    }
    expect(hashAgentConfig(reordered)).toBe(hashAgentConfig(base))
  })

  it('trata una clave ausente y una undefined como lo mismo', () => {
    const { saveOutput: _drop, ...withoutOutput } = base
    expect(hashAgentConfig(withoutOutput as AgentConfigIdentity)).toBe(hashAgentConfig(base))
  })

  // El orden de `tools` SÍ es significativo — es el orden en que se ofrecen al
  // modelo. Dos agentes que declaran las mismas tools en distinto orden no son
  // el mismo agente, y comparar sus runs mezclaría dos comportamientos.
  it('distingue el orden de un array', () => {
    expect(hashAgentConfig({ ...base, tools: ['update_issue_body', 'fs_read'] })).not.toBe(
      hashAgentConfig(base),
    )
  })

  it.each([
    ['prompt', { prompt: 'Otro prompt' }],
    ['systemPromptBlocks', { systemPromptBlocks: [{ type: 'text', text: 'Otra cosa.' }] }],
    ['tools', { tools: ['fs_read'] }],
    ['variables', { variables: { tone: 'casual' } }],
    ['provider', { provider: 'remote:mac-mini' }],
    ['providerConfig', { providerConfig: { model: 'claude-opus-4-1' } }],
    ['exits', { exits: { success: 'Review' } }],
  ] as Array<[string, Partial<AgentConfigIdentity>]>)('cambia cuando cambia %s', (_name, patch) => {
    expect(hashAgentConfig({ ...base, ...patch })).not.toBe(hashAgentConfig(base))
  })

  it('produce 12 chars hex', () => {
    expect(hashAgentConfig(base)).toMatch(/^[0-9a-f]{12}$/)
  })
})
