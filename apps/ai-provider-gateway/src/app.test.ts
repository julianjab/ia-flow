import { describe, expect, it } from 'bun:test'
import type { IAgentProvider, ProviderInput } from '@ia-flow/ai-providers'
import { createApp } from './app.js'
import type { Log } from './logger.js'

function silentLog(): Log {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}

function fakeProvider(id: string, run: (input: ProviderInput) => Promise<unknown>): IAgentProvider {
  return {
    id,
    kind: 'sync',
    name: id,
    description: `fake ${id}`,
    run: run as IAgentProvider['run'],
  }
}

function baseInput(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    step: 'implement',
    taskId: 't1',
    taskTitle: 'x',
    taskDescription: '',
    taskType: 'functional',
    repos: [],
    repoPaths: {},
    prompt: 'hola',
    ...overrides,
  }
}

describe('createApp — auth', () => {
  it('sin token configurado → 500 en cualquier ruta', async () => {
    const app = createApp({ providers: new Map(), token: undefined, log: silentLog() })
    const res = await app.request('/v1/providers')
    expect(res.status).toBe(500)
  })

  it('sin Authorization header → 401', async () => {
    const app = createApp({ providers: new Map(), token: 'secret', log: silentLog() })
    const res = await app.request('/v1/providers')
    expect(res.status).toBe(401)
  })

  it('token incorrecto → 401', async () => {
    const app = createApp({ providers: new Map(), token: 'secret', log: silentLog() })
    const res = await app.request('/v1/providers', {
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.status).toBe(401)
  })

  it('token correcto → pasa el middleware', async () => {
    const app = createApp({ providers: new Map(), token: 'secret', log: silentLog() })
    const res = await app.request('/v1/providers', {
      headers: { authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
  })
})

describe('createApp — GET /v1/providers', () => {
  it('lista id/kind/name/description de cada provider registrado', async () => {
    const providers = new Map<string, IAgentProvider>([
      ['a', fakeProvider('a', async () => ({ content: '', mode: 'api' }))],
    ])
    const app = createApp({ providers, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/providers', { headers: { authorization: 'Bearer secret' } })
    const body = await res.json()
    expect(body).toEqual({
      providers: [{ id: 'a', kind: 'sync', name: 'a', description: 'fake a' }],
    })
  })
})

describe('createApp — POST /v1/providers/:id/run', () => {
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }

  it('provider inexistente → 404', async () => {
    const app = createApp({ providers: new Map(), token: 'secret', log: silentLog() })
    const res = await app.request('/v1/providers/nope/run', {
      method: 'POST',
      headers,
      body: JSON.stringify(baseInput()),
    })
    expect(res.status).toBe(404)
  })

  it('body no es JSON valido → 400', async () => {
    const providers = new Map<string, IAgentProvider>([
      ['a', fakeProvider('a', async () => ({ content: '', mode: 'api' }))],
    ])
    const app = createApp({ providers, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/providers/a/run', {
      method: 'POST',
      headers,
      body: 'no es json',
    })
    expect(res.status).toBe(400)
  })

  it('body sin taskId/prompt → 400', async () => {
    const providers = new Map<string, IAgentProvider>([
      ['a', fakeProvider('a', async () => ({ content: '', mode: 'api' }))],
    ])
    const app = createApp({ providers, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/providers/a/run', {
      method: 'POST',
      headers,
      body: JSON.stringify({ foo: 'bar' }),
    })
    expect(res.status).toBe(400)
  })

  it('corre el provider y devuelve el ProviderOutput', async () => {
    let received: ProviderInput | undefined
    const providers = new Map<string, IAgentProvider>([
      [
        'a',
        fakeProvider('a', async (input) => {
          received = input
          return { content: 'listo', mode: 'api', stopReason: 'end_turn' }
        }),
      ],
    ])
    const app = createApp({ providers, token: 'secret', log: silentLog() })
    const input = baseInput({ prompt: 'hacé esto' })
    const res = await app.request('/v1/providers/a/run', {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ content: 'listo', mode: 'api', stopReason: 'end_turn' })
    expect(received?.taskId).toBe('t1')
    expect(received?.prompt).toBe('hacé esto')
  })

  it('el provider tira → 500 con el mensaje de error', async () => {
    const providers = new Map<string, IAgentProvider>([
      [
        'a',
        fakeProvider('a', async () => {
          throw new Error('boom')
        }),
      ],
    ])
    const app = createApp({ providers, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/providers/a/run', {
      method: 'POST',
      headers,
      body: JSON.stringify(baseInput()),
    })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'boom' })
  })
})
