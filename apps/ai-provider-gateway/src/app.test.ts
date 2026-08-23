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

describe('createApp — capacidad', () => {
  const auth = { headers: { authorization: 'Bearer secret' } }
  const runReq = (body: ProviderInput) => ({
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('sin maxConcurrentRuns el gateway se declara siempre disponible', async () => {
    const app = createApp({ provider: noopProvider, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/capacity', auth)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ running: 0, maxConcurrentRuns: null, accepting: true })
  })

  it('/v1/capacity refleja los runs en vuelo y deja de aceptar al llegar al tope', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const app = createApp({
      provider: fakeProvider(async () => {
        await gate
        return { content: '', mode: 'api' }
      }),
      token: 'secret',
      log: silentLog(),
      maxConcurrentRuns: 1,
    })

    const inFlight = app.request('/v1/run', runReq(baseInput()))
    // Deja que el handler entre al provider antes de sondear.
    await new Promise((r) => setTimeout(r, 10))

    const capacity = await (await app.request('/v1/capacity', auth)).json()
    expect(capacity).toEqual({ running: 1, maxConcurrentRuns: 1, accepting: false })

    // Saturado: 503, no 500 — es "volvé después", no "esto falló".
    const rejected = await app.request('/v1/run', runReq(baseInput({ taskId: 't2' })))
    expect(rejected.status).toBe(503)

    release()
    await inFlight
    const after = await (await app.request('/v1/capacity', auth)).json()
    expect(after).toEqual({ running: 0, maxConcurrentRuns: 1, accepting: true })
  })

  it('un provider que lanza libera igual el slot', async () => {
    const app = createApp({
      provider: fakeProvider(async () => {
        throw new Error('boom')
      }),
      token: 'secret',
      log: silentLog(),
      maxConcurrentRuns: 1,
    })

    expect((await app.request('/v1/run', runReq(baseInput()))).status).toBe(500)

    const capacity = await (await app.request('/v1/capacity', auth)).json()
    expect(capacity.running).toBe(0)
    expect(capacity.accepting).toBe(true)
  })

  it('un maxConcurrentRuns de 0 no limita (mismo criterio que el resto de los caps)', async () => {
    const app = createApp({
      provider: noopProvider,
      token: 'secret',
      log: silentLog(),
      maxConcurrentRuns: 0,
    })
    const res = await app.request('/v1/run', runReq(baseInput()))
    expect(res.status).toBe(200)
  })

  it('/v1/capacity exige auth como el resto', async () => {
    const app = createApp({ provider: noopProvider, token: 'secret', log: silentLog() })
    expect((await app.request('/v1/capacity')).status).toBe(401)
  })
})
