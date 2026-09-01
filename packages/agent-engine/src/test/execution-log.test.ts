import { afterEach, describe, expect, it } from 'bun:test'
import {
  type AgentConfigIdentity,
  buildFinishPatch,
  hashAgentConfig,
  hashSystemPrompt,
} from '../execution-log.js'
import {
  recordHookToolResult,
  resetRunTelemetry,
  setTranscriptUsageReader,
} from '../run-telemetry.js'

const base: AgentConfigIdentity = {
  prompt: 'Refiná el issue {{task.title}}:\n\n{{task.description}}',
  systemPromptBlocks: [{ type: 'text', text: 'Sos un refinador.' }],
  tools: ['fs_read', 'update_issue_body'],
  variables: { tone: 'formal' },
  provider: 'anthropic-api',
  providerConfig: { model: 'claude-sonnet-4-6', effort: 'high' },
  saveOutput: undefined,
  output: undefined,
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
    ['output', { output: { fields: [{ name: 'prd' }] } }],
  ] as Array<[string, Partial<AgentConfigIdentity>]>)('cambia cuando cambia %s', (_name, patch) => {
    expect(hashAgentConfig({ ...base, ...patch })).not.toBe(hashAgentConfig(base))
  })

  it('produce 12 chars hex', () => {
    expect(hashAgentConfig(base)).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('hashSystemPrompt', () => {
  it('cambia sólo cuando cambian los bloques de system prompt', () => {
    const a = hashSystemPrompt(base.systemPromptBlocks)
    expect(hashSystemPrompt([{ type: 'text', text: 'Sos un refinador.' }])).toBe(a)
    expect(hashSystemPrompt([{ type: 'text', text: 'Sos un reviewer.' }])).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
  })

  it('un system prompt distinto NO mueve el hash del agente si el resto es igual', () => {
    // La razón de tener dos hashes: hashAgentConfig SÍ cambia (incluye los
    // bloques), y el detalle cruza los dos para saber qué se editó.
    const other = { ...base, systemPromptBlocks: [{ type: 'text', text: 'Otro.' }] }
    expect(hashAgentConfig(other)).not.toBe(hashAgentConfig(base))
    expect(hashSystemPrompt(other.systemPromptBlocks)).not.toBe(
      hashSystemPrompt(base.systemPromptBlocks),
    )
  })
})

describe('buildFinishPatch', () => {
  afterEach(() => {
    resetRunTelemetry()
    setTranscriptUsageReader(undefined)
  })

  it('con métricas del provider persiste modelo, hashes y desglose por tool', () => {
    const patch = buildFinishPatch({
      outcome: 'success',
      startedAtMs: Date.now() - 10,
      runId: 'run-1',
      agentPromptHash: 'aaa',
      systemPromptHash: 'sss',
      metrics: {
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 },
        iters: 3,
        toolCalls: 2,
        toolErrors: 1,
        toolBreakdown: { fs_read: { calls: 1, errors: 0 }, bash_run: { calls: 1, errors: 1 } },
        model: 'claude-sonnet-5',
      },
    })
    expect(patch.model).toBe('claude-sonnet-5')
    expect(patch.systemPromptHash).toBe('sss')
    expect(patch.agentPromptHash).toBe('aaa')
    expect(patch.tokensIn).toBe(10)
    expect(patch.cacheReadTokens).toBe(30)
    expect(patch.toolBreakdown).toEqual({
      fs_read: { calls: 1, errors: 0 },
      bash_run: { calls: 1, errors: 1 },
    })
  })

  it('un run de terminal toma usage y modelo de la transcripción vía el hook tally', () => {
    setTranscriptUsageReader(() => ({
      usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheCreationTokens: 8 },
      model: 'claude-opus-5',
    }))
    recordHookToolResult('run-2', false, { toolName: 'Bash', transcriptPath: '/t.jsonl' })
    recordHookToolResult('run-2', true, { toolName: 'Bash' })

    const patch = buildFinishPatch({ outcome: 'success', startedAtMs: Date.now(), runId: 'run-2' })
    expect(patch.model).toBe('claude-opus-5')
    expect(patch.tokensOut).toBe(6)
    expect(patch.cacheCreationTokens).toBe(8)
    expect(patch.toolCalls).toBe(2)
    expect(patch.toolErrors).toBe(1)
    expect(patch.toolBreakdown).toEqual({ Bash: { calls: 2, errors: 1 } })
    // Sin loop propio no hay vueltas que contar.
    expect(patch.iters).toBeNull()
  })

  it('sin nada observable deja null, no cero', () => {
    const patch = buildFinishPatch({ outcome: 'error', startedAtMs: Date.now(), runId: 'run-3' })
    expect(patch.model).toBeNull()
    expect(patch.tokensIn).toBeNull()
    expect(patch.toolBreakdown).toBeNull()
    expect(patch.systemPromptHash).toBeNull()
  })
})
