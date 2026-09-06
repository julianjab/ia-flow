import { afterEach, describe, expect, it } from 'bun:test'
import { agentRepo } from '../../composition/container.js'
import { createAgentsCrudRouter } from '../agents-crud.js'

// El `providerConfig` de un agente puede overridear el `model` global — ver
// el PRD del issue #143. Guardar effort/taskBudgetTokens contra un modelo
// que no los soporta tiene que rechazarse acá, no en el primer request a la
// API de Anthropic.
describe('POST /api/agents-crud — validación model × effort/taskBudgetTokens', () => {
  const app = createAgentsCrudRouter()

  afterEach(() => {
    for (const id of ['test-agent-effort-invalid', 'test-agent-effort-valid']) {
      if (agentRepo.inScope(null).some((a) => a.id === id)) agentRepo.deleteById(id)
    }
  })

  it('rechaza effort xhigh en un agente sin model override (hereda el default Sonnet)', async () => {
    const res = await app.request('/?scope=global', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'test-agent-effort-invalid',
        provider: 'anthropic-api',
        prompt: 'hi',
        providerConfig: { effort: 'xhigh' },
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('xhigh')
    expect(body.error).toContain('Opus')
  })

  it('acepta effort xhigh cuando el agente también overridea el model a Opus', async () => {
    const res = await app.request('/?scope=global', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'test-agent-effort-valid',
        provider: 'anthropic-api',
        prompt: 'hi',
        providerConfig: { model: 'claude-opus-4-7', effort: 'xhigh' },
      }),
    })
    expect(res.status).toBe(201)
  })
})
