import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { promptRepo } from '../../composition/container.js'
import { createProvidersRouter } from '../providers.js'

// PUT /api/providers/config es el borde donde se guarda el default global de
// `anthropic-api` — ver el PRD del issue #143. Antes esta ruta aceptaba
// cualquier combinación model×effort×taskBudgetTokens y el 400 recién
// aparecía en el primer request a la API de Anthropic.
describe('PUT /api/providers/config — validación model × effort/taskBudgetTokens', () => {
  const app = createProvidersRouter()
  let originalDbConfig: Record<string, unknown> | null = null

  beforeAll(() => {
    originalDbConfig = promptRepo.getProviderConfigBlob()
  })

  afterAll(() => {
    if (originalDbConfig !== null) promptRepo.setProviderConfigBlob(originalDbConfig)
    else promptRepo.deleteProviderConfigBlob()
  })

  it('rechaza effort xhigh contra el modelo default (Sonnet)', async () => {
    const res = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anthropicApi: { model: 'claude-sonnet-4-6', effort: 'xhigh' } }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('xhigh')
    expect(body.error).toContain('Opus')
  })

  it('rechaza taskBudgetTokens contra un modelo que no es Opus', async () => {
    const res = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        anthropicApi: { model: 'claude-sonnet-4-6', taskBudgetTokens: 50000 },
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('taskBudgetTokens')
  })

  it('acepta effort xhigh contra un modelo Opus', async () => {
    const res = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anthropicApi: { model: 'claude-opus-4-7', effort: 'xhigh' } }),
    })
    expect(res.status).toBe(200)
  })
})
