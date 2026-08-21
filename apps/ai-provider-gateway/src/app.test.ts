import { describe, expect, it } from 'bun:test'
import type { IAgentProvider, ProviderInput } from '@ia-flow/ai-providers'
import { createApp } from './app.js'
import type { Log } from './logger.js'

function silentLog(): Log {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}

function fakeProvider(run: (input: ProviderInput) => Promise<unknown>): IAgentProvider {
  return {
    id: 'a',
    kind: 'sync',
    name: 'a',
    description: 'fake a',
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

const noopProvider = fakeProvider(async () => ({ content: '', mode: 'api' }))

describe('createApp — auth', () => {
  it('sin token configurado → 500 en cualquier ruta', async () => {
    const app = createApp({ provider: noopProvider, token: undefined, log: silentLog() })
    const res = await app.request('/v1/provider')
    expect(res.status).toBe(500)
  })

  it('sin Authorization header → 401', async () => {
    const app = createApp({ provider: noopProvider, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/provider')
    expect(res.status).toBe(401)
  })

  it('token incorrecto → 401', async () => {
    const app = createApp({ provider: noopProvider, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/provider', {
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.status).toBe(401)
  })

  it('token correcto → pasa el middleware', async () => {
    const app = createApp({ provider: noopProvider, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/provider', {
      headers: { authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
  })
})

describe('createApp — GET /v1/provider', () => {
  it('describe el provider que expone esta instancia', async () => {
    const app = createApp({ provider: noopProvider, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/provider', { headers: { authorization: 'Bearer secret' } })
    const body = await res.json()
    expect(body).toEqual({ kind: 'sync', name: 'a', description: 'fake a' })
  })
})

describe('createApp — POST /v1/run', () => {
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }

  it('body no es JSON valido → 400', async () => {
    const app = createApp({ provider: noopProvider, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/run', {
      method: 'POST',
      headers,
      body: 'no es json',
    })
    expect(res.status).toBe(400)
  })

  it('body sin taskId/prompt → 400', async () => {
    const app = createApp({ provider: noopProvider, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/run', {
      method: 'POST',
      headers,
      body: JSON.stringify({ foo: 'bar' }),
    })
    expect(res.status).toBe(400)
  })

  it('corre el provider y devuelve el ProviderOutput', async () => {
    let received: ProviderInput | undefined
    const provider = fakeProvider(async (input) => {
      received = input
      return { content: 'listo', mode: 'api', stopReason: 'end_turn' }
    })
    const app = createApp({ provider, token: 'secret', log: silentLog() })
    const input = baseInput({ prompt: 'hacé esto' })
    const res = await app.request('/v1/run', {
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
    const provider = fakeProvider(async () => {
      throw new Error('boom')
    })
    const app = createApp({ provider, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/run', {
      method: 'POST',
      headers,
      body: JSON.stringify(baseInput()),
    })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'boom' })
  })
})
