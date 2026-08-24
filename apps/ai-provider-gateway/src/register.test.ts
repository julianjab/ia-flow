import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Log } from './logger.js'
import { registerSelf } from './register.js'

const ENV_KEYS = [
  'IA_FLOW_REGISTER_SERVER_URLS',
  'IA_FLOW_GATEWAY_PUBLIC_URL',
  'API_AI_PROVIDER_TOKEN',
  'IA_FLOW_PROVIDER_NAME',
  'IA_FLOW_REGISTER_RETRIES',
  'IA_FLOW_REGISTER_RETRY_DELAY_MS',
] as const

const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = Bun.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete Bun.env[k]
    else Bun.env[k] = originalEnv[k]
  }
})

function silentLog(): Log {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}

// retries:1/delay:0 por default en los tests que no ejercitan el retry en sí
// — evita que un test de "falla y no reintenta más" tarde segundos de
// verdad esperando el IA_FLOW_REGISTER_RETRY_DELAY_MS default (2000ms).
function setEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete Bun.env[k]
  Bun.env.IA_FLOW_REGISTER_RETRIES = '1'
  Bun.env.IA_FLOW_REGISTER_RETRY_DELAY_MS = '0'
  for (const [k, v] of Object.entries(overrides)) Bun.env[k] = v
}

describe('registerSelf', () => {
  it('sin IA_FLOW_REGISTER_SERVER_URLS → no hace ningún fetch', async () => {
    setEnv({})
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      throw new Error('no debería llamarse')
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })
    expect(calls).toBe(0)
  })

  it('con servers pero sin publicUrl/token/name → no hace fetch (solo warn)', async () => {
    setEnv({ IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001' })
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      throw new Error('no debería llamarse')
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })
    expect(calls).toBe(0)
  })

  it('borra registraciones previas con el mismo name antes de crear la nueva', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001',
      IA_FLOW_GATEWAY_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
    })

    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      })
      if (init?.method === undefined) {
        return new Response(
          JSON.stringify({
            registrations: [
              { id: 'stale-1', name: 'julianbuitrago-mac' },
              { id: 'other', name: 'otro-provider' },
            ],
          }),
          { status: 200 },
        )
      }
      if (init.method === 'DELETE') return new Response(null, { status: 200 })
      return new Response(JSON.stringify({ registration: { id: 'fresh-1' } }), { status: 201 })
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })

    expect(calls).toEqual([
      { url: 'http://localhost:3001/api/provider-registrations', method: 'GET', body: undefined },
      {
        url: 'http://localhost:3001/api/provider-registrations/stale-1',
        method: 'DELETE',
        body: undefined,
      },
      {
        url: 'http://localhost:3001/api/provider-registrations',
        method: 'POST',
        body: { name: 'julianbuitrago-mac', baseUrl: 'http://localhost:3002', token: 'tok' },
      },
    ])
  })

  it('registra contra varios servers (comma-separated)', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://a.example.com, http://b.example.com',
      IA_FLOW_GATEWAY_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
    })

    const posted: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method === undefined) {
        return new Response(JSON.stringify({ registrations: [] }), { status: 200 })
      }
      if (init.method === 'POST') {
        posted.push(url)
        return new Response(JSON.stringify({ registration: { id: 'x' } }), { status: 201 })
      }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })

    expect(posted).toEqual([
      'http://a.example.com/api/provider-registrations',
      'http://b.example.com/api/provider-registrations',
    ])
  })

  it('un server que falla (network error) no frena el registro contra el resto', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://caido.example.com,http://ok.example.com',
      IA_FLOW_GATEWAY_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
    })

    const posted: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.startsWith('http://caido.example.com')) throw new Error('ECONNREFUSED')
      if (init?.method === undefined) {
        return new Response(JSON.stringify({ registrations: [] }), { status: 200 })
      }
      if (init.method === 'POST') {
        posted.push(url)
        return new Response(JSON.stringify({ registration: { id: 'x' } }), { status: 201 })
      }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })

    expect(posted).toEqual(['http://ok.example.com/api/provider-registrations'])
  })

  it('POST no-2xx → loguea warn y sigue (no lanza)', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001',
      IA_FLOW_GATEWAY_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
    })
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === undefined) {
        return new Response(JSON.stringify({ registrations: [] }), { status: 200 })
      }
      return new Response('boom', { status: 500 })
    }) as unknown as typeof fetch

    const results = await registerSelf({ log: silentLog(), fetchImpl })
    expect(results.every((r) => !r.ok)).toBe(true)
  })

  it('reintenta hasta IA_FLOW_REGISTER_RETRIES veces y se recupera si un intento posterior anda', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001',
      IA_FLOW_GATEWAY_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
      IA_FLOW_REGISTER_RETRIES: '3',
      IA_FLOW_REGISTER_RETRY_DELAY_MS: '0',
    })

    let postAttempts = 0
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === undefined) {
        return new Response(JSON.stringify({ registrations: [] }), { status: 200 })
      }
      if (init.method === 'POST') {
        postAttempts++
        // Los primeros dos intentos fallan (server todavía no está listo,
        // caso típico de arranque en frío en compose) — el tercero anda.
        if (postAttempts < 3) return new Response('server not ready', { status: 503 })
        return new Response(JSON.stringify({ registration: { id: 'x' } }), { status: 201 })
      }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    await registerSelf({ log: silentLog(), fetchImpl })

    expect(postAttempts).toBe(3)
  })

  it('agota todos los intentos si nunca anda → no lanza, no hace más de IA_FLOW_REGISTER_RETRIES POSTs', async () => {
    setEnv({
      IA_FLOW_REGISTER_SERVER_URLS: 'http://localhost:3001',
      IA_FLOW_GATEWAY_PUBLIC_URL: 'http://localhost:3002',
      API_AI_PROVIDER_TOKEN: 'tok',
      IA_FLOW_PROVIDER_NAME: 'julianbuitrago-mac',
      IA_FLOW_REGISTER_RETRIES: '3',
      IA_FLOW_REGISTER_RETRY_DELAY_MS: '0',
    })

    let postAttempts = 0
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === undefined) {
        return new Response(JSON.stringify({ registrations: [] }), { status: 200 })
      }
      if (init.method === 'POST') {
        postAttempts++
        return new Response('boom', { status: 500 })
      }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const results = await registerSelf({ log: silentLog(), fetchImpl })
    expect(results.every((r) => !r.ok)).toBe(true)
    expect(postAttempts).toBe(3)
  })
})
