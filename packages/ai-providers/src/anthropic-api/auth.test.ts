import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  ANTHROPIC_API_URL,
  ANTHROPIC_VERSION,
  CLAUDE_CODE_BETAS,
  buildAnthropicAuthHeader,
  buildAnthropicHeaders,
  requestAnthropicApi,
} from './auth.js'

const originalFetch = globalThis.fetch
const originalOauth = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
const originalApiKey = Bun.env.ANTHROPIC_API_KEY

beforeEach(() => {
  delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  delete Bun.env.ANTHROPIC_API_KEY
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalOauth === undefined) delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  else Bun.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth
  if (originalApiKey === undefined) delete Bun.env.ANTHROPIC_API_KEY
  else Bun.env.ANTHROPIC_API_KEY = originalApiKey
})

describe('buildAnthropicAuthHeader', () => {
  it('prefiere CLAUDE_CODE_OAUTH_TOKEN sobre ANTHROPIC_API_KEY cuando ambos están seteados', () => {
    Bun.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'
    Bun.env.ANTHROPIC_API_KEY = 'sk-test'

    expect(buildAnthropicAuthHeader()).toEqual({ Authorization: 'Bearer oauth-token' })
  })

  it('usa x-api-key cuando no hay oauth token', () => {
    Bun.env.ANTHROPIC_API_KEY = 'sk-test'

    expect(buildAnthropicAuthHeader()).toEqual({ 'x-api-key': 'sk-test' })
  })

  it('lanza cuando no hay ninguna credencial configurada', () => {
    expect(() => buildAnthropicAuthHeader()).toThrow(/No auth configured/)
  })
})

describe('buildAnthropicHeaders', () => {
  it('usa CLAUDE_CODE_BETAS y ANTHROPIC_VERSION como default sin opts', () => {
    Bun.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'

    const headers = buildAnthropicHeaders()

    expect(headers['content-type']).toBe('application/json')
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(headers['anthropic-beta']).toBe(CLAUDE_CODE_BETAS.join(','))
    expect(headers.Authorization).toBe('Bearer oauth-token')
  })

  it('agrega extraBetas a la lista base sin pisarla', () => {
    Bun.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'

    const headers = buildAnthropicHeaders({ extraBetas: ['mcp-client-2025-11-20'] })

    const betas = headers['anthropic-beta'].split(',')
    expect(betas).toEqual([...CLAUDE_CODE_BETAS, 'mcp-client-2025-11-20'])
  })

  it('usa una lista base custom (`betas`) en vez del default fijo', () => {
    Bun.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'

    const headers = buildAnthropicHeaders({
      betas: ['custom-beta-1'],
      extraBetas: ['task-budgets-2026-03-13'],
    })

    expect(headers['anthropic-beta']).toBe('custom-beta-1,task-budgets-2026-03-13')
  })

  it('no duplica una beta que ya está en la lista base', () => {
    Bun.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'

    const headers = buildAnthropicHeaders({
      betas: ['task-budgets-2026-03-13'],
      extraBetas: ['task-budgets-2026-03-13'],
    })

    expect(headers['anthropic-beta']).toBe('task-budgets-2026-03-13')
  })

  it('permite overridear la versión del wire protocol', () => {
    Bun.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'

    const headers = buildAnthropicHeaders({ version: '2099-01-01' })

    expect(headers['anthropic-version']).toBe('2099-01-01')
  })

  it('propaga el error de auth cuando no hay credenciales', () => {
    expect(() => buildAnthropicHeaders()).toThrow(/No auth configured/)
  })
})

describe('requestAnthropicApi', () => {
  it('hace POST a ANTHROPIC_API_URL con el body serializado, los headers y el signal dados', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url
      capturedInit = init
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const headers = { 'content-type': 'application/json', Authorization: 'Bearer x' }
    const controller = new AbortController()
    const res = await requestAnthropicApi(
      { model: 'claude-haiku-4-5-20251001' },
      { headers, signal: controller.signal },
    )

    expect(capturedUrl).toBe(ANTHROPIC_API_URL)
    expect(capturedInit?.method).toBe('POST')
    expect(capturedInit?.headers).toBe(headers)
    expect(capturedInit?.body).toBe(JSON.stringify({ model: 'claude-haiku-4-5-20251001' }))
    expect(capturedInit?.signal).toBe(controller.signal)
    expect(res.status).toBe(200)
  })

  it('funciona sin signal (opcional)', async () => {
    let capturedInit: RequestInit | undefined
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedInit = init
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await requestAnthropicApi({ foo: 'bar' }, { headers: {} })

    expect(capturedInit?.signal).toBeUndefined()
  })

  it('propaga el rechazo de fetch (network error) sin envolverlo', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    await expect(requestAnthropicApi({}, { headers: {} })).rejects.toThrow('network down')
  })
})
