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
    expect(capacity.accepting).toBe(false)
    expect(capacity.running).toBe(1)
    // El motivo viaja con la respuesta: es lo que el daemon loguea del otro
    // lado para que "diferido" no sea un misterio.
    expect(capacity.reason).toContain('1/1')

    // Saturado: 503, no 500 — es "volvé después", no "esto falló".
    const rejected = await app.request('/v1/run', runReq(baseInput({ taskId: 't2' })))
    expect(rejected.status).toBe(503)
    expect((await rejected.json()).error).toContain('1/1')

    release()
    await inFlight
    const after = await (await app.request('/v1/capacity', auth)).json()
    expect(after.running).toBe(0)
    expect(after.accepting).toBe(true)
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

describe('POST /v1/run — workspace remoto', () => {
  const workspace = {
    taskId: 't1',
    taskTitle: 'x',
    step: 'implement' as const,
    repos: [
      { name: 'demo', path: '/en/la/maquina/del/daemon', githubOwner: 'acme', githubRepo: 'demo' },
    ],
    primaryRepo: 'demo',
    branch: 'feat/algo',
    needsWrite: true,
  }

  async function runWith(provider: IAgentProvider, body: ProviderInput) {
    return app_(provider).request('/v1/run', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  function app_(provider: IAgentProvider) {
    return createApp({ provider, token: 'secret', log: silentLog() })
  }

  it('el provider resuelve el terreno acá y el run corre sobre ESOS paths, no los del daemon', async () => {
    let seen: ProviderInput | undefined
    const provider: IAgentProvider = {
      ...fakeProvider(async (input) => {
        seen = input
        return { content: 'ok', mode: 'api' }
      }),
      prepareWorkspace: async () => ({
        repoPaths: { demo: '/gateway/repos/acme/demo/.worktrees/task-1' },
        writePaths: ['/gateway/repos/acme/demo/.worktrees/task-1'],
        cwd: '/gateway/repos/acme/demo/.worktrees/task-1',
        branch: 'feat/algo',
      }),
    }

    const res = await runWith(
      provider,
      baseInput({ repoPaths: { demo: '/en/la/maquina/del/daemon' }, workspace }),
    )

    expect(res.status).toBe(200)
    expect(seen?.repoPaths.demo).toBe('/gateway/repos/acme/demo/.worktrees/task-1')
    expect(seen?.cwd).toBe('/gateway/repos/acme/demo/.worktrees/task-1')
    expect(seen?.writePaths).toEqual(['/gateway/repos/acme/demo/.worktrees/task-1'])
  })

  it('el permiso de escritura sigue siendo del engine — un plan generoso no lo abre', async () => {
    let seen: ProviderInput | undefined
    const provider: IAgentProvider = {
      ...fakeProvider(async (input) => {
        seen = input
        return { content: 'ok', mode: 'api' }
      }),
      // Devuelve zonas escribibles aunque el request diga que el agente no escribe.
      prepareWorkspace: async () => ({
        repoPaths: { demo: '/gateway/repos/acme/demo' },
        writePaths: ['/gateway/repos/acme/demo'],
      }),
    }

    await runWith(provider, baseInput({ workspace: { ...workspace, needsWrite: false } }))

    expect(seen?.writePaths).toEqual([])
  })

  it('sin `workspace` en el input el run pasa tal cual (gateway sin filesystem de proyecto)', async () => {
    let seen: ProviderInput | undefined
    let prepared = false
    const provider: IAgentProvider = {
      ...fakeProvider(async (input) => {
        seen = input
        return { content: 'ok', mode: 'api' }
      }),
      prepareWorkspace: async () => {
        prepared = true
        return { repoPaths: {} }
      },
    }

    await runWith(provider, baseInput({ repoPaths: { demo: '/tal/cual' } }))

    expect(prepared).toBe(false)
    expect(seen?.repoPaths.demo).toBe('/tal/cual')
  })

  it('un workspace inválido se rechaza en el borde, no llega al provider', async () => {
    let ran = false
    const provider: IAgentProvider = {
      ...fakeProvider(async () => {
        ran = true
        return { content: 'ok', mode: 'api' }
      }),
      prepareWorkspace: async () => ({ repoPaths: {} }),
    }

    const res = await runWith(
      provider,
      baseInput({ workspace: { ...workspace, repos: 'nope' } as never }),
    )

    expect(res.status).toBe(500)
    expect(ran).toBe(false)
  })
})
