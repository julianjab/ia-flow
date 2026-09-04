import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  ANTHROPIC_API_URL,
  ANTHROPIC_VERSION,
  CLAUDE_CODE_BETAS,
  buildAnthropicAuthHeader,
  buildAnthropicHeaders,
  requestAnthropicApi,
  requestAnthropicApiWithRetry,
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

describe('requestAnthropicApiWithRetry', () => {
  it('un 529 seguido de un 200 completa sin agotar los reintentos', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) return new Response('{"error":"overloaded"}', { status: 529 })
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch

    const res = await requestAnthropicApiWithRetry({}, { headers: {}, maxRetries: 3 })

    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })

  it('un 429 con retry-after espera al menos esa cantidad de segundos antes de reintentar', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) {
        return new Response('{"error":"rate_limited"}', {
          status: 429,
          headers: { 'retry-after': '1' },
        })
      }
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch

    const start = Date.now()
    const res = await requestAnthropicApiWithRetry({}, { headers: {}, maxRetries: 3 })
    const elapsed = Date.now() - start

    expect(res.status).toBe(200)
    expect(elapsed).toBeGreaterThanOrEqual(1000)
  }, 10000)

  it('no reintenta un 400 — vuelve el primer intento tal cual', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('{"error":"bad_request"}', { status: 400 })
    }) as unknown as typeof fetch

    const res = await requestAnthropicApiWithRetry({}, { headers: {}, maxRetries: 3 })

    expect(res.status).toBe(400)
    expect(calls).toBe(1)
  })

  it('agota los reintentos y devuelve el status del último intento', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('{"error":"overloaded"}', { status: 529 })
    }) as unknown as typeof fetch

    const res = await requestAnthropicApiWithRetry({}, { headers: {}, maxRetries: 2 })

    expect(res.status).toBe(529)
    expect(calls).toBe(3)
  })

  it('reintenta un error de conexión y termina bien si el siguiente intento conecta', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) throw new Error('ECONNRESET')
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch

    const res = await requestAnthropicApiWithRetry({}, { headers: {}, maxRetries: 2 })

    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })

  it('propaga un error de conexión sin reintentar cuando maxRetries es 0', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    await expect(requestAnthropicApiWithRetry({}, { headers: {} })).rejects.toThrow('ECONNRESET')
    expect(calls).toBe(1)
  })

  it('un abort corta la cadena de reintentos en vez de esperar', async () => {
    let calls = 0
    const controller = new AbortController()
    globalThis.fetch = (async () => {
      calls++
      return new Response('{"error":"rate_limited"}', {
        status: 429,
        headers: { 'retry-after': '5' },
      })
    }) as unknown as typeof fetch

    const promise = requestAnthropicApiWithRetry(
      {},
      { headers: {}, maxRetries: 3, signal: controller.signal },
    )
    // Deja que el primer fetch resuelva y entre a la espera del backoff antes de abortar.
    await new Promise((r) => setTimeout(r, 0))
    controller.abort()

    await expect(promise).rejects.toThrow()
    expect(calls).toBe(1)
  })
})
