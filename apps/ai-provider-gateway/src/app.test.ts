import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IAgentProvider, ProviderInput, SessionHandle } from '@ia-flow/ai-providers'
import type { Hono } from 'hono'
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
    // `id` y `available` son para la pantalla: el server principal los
    // ignora, sigue mirando kind/name/description.
    expect(body).toEqual({
      kind: 'sync',
      name: 'a',
      description: 'fake a',
      id: 'a',
      available: [],
    })
  })
})

describe('createApp — PUT /v1/provider', () => {
  const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }

  function appWithProviders(registered: string[][] = []) {
    const saved: Array<{ providerId: string | null }> = []
    const app = createApp({
      provider: fakeProvider(async () => ({})),
      token: 'secret',
      log: silentLog(),
      state: {
        registerServerUrls: ['http://localhost:3011'],
        providerId: null,
        maxConcurrentRuns: null,
        admissionRules: [],
      },
      onStateChange: (st) => {
        saved.push({ providerId: st.providerId })
      },
      availableProviderIds: ['anthropic-api', 'claude-print'],
      createProviderById: (id) => ({
        id,
        kind: 'sync',
        name: id,
        description: `provider ${id}`,
        run: async () => ({ content: '', mode: 'api' as const }),
      }),
      registerTo: async (urls) => {
        registered.push(urls)
        return urls.map((serverUrl) => ({ serverUrl, ok: true }))
      },
    })
    return { app, saved }
  }

  it('cambia el provider en caliente y lo recuerda', async () => {
    const { app, saved } = appWithProviders()

    const res = await app.request('/v1/provider', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ id: 'claude-print' }),
    })

    expect(res.status).toBe(200)
    expect((await res.json()).name).toBe('claude-print')
    expect(saved.at(-1)?.providerId).toBe('claude-print')
    // Y queda reflejado en lo que se consulta después.
    const after = await app.request('/v1/provider', { headers: auth })
    expect((await after.json()).id).toBe('claude-print')
  })

  it('se vuelve a registrar: el server guardó el nombre del provider viejo', async () => {
    const registered: string[][] = []
    const { app } = appWithProviders(registered)

    await app.request('/v1/provider', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ id: 'claude-print' }),
    })

    expect(registered).toEqual([['http://localhost:3011']])
  })

  it('un id desconocido se rechaza en vez de caer a un default silencioso', async () => {
    const { app, saved } = appWithProviders()

    const res = await app.request('/v1/provider', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ id: 'inventado' }),
    })

    expect(res.status).toBe(400)
    expect(saved).toHaveLength(0)
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

describe('GET / — la pantalla del gateway', () => {
  const app = () =>
    createApp({ provider: fakeProvider(async () => ({})), token: 'secreto', log: silentLog() })

  it('se sirve sin token: es HTML pelado, no lleva datos adentro', async () => {
    const res = await app().request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('no filtra el token ni el estado del provider en el HTML', async () => {
    const html = await (await app().request('/')).text()
    expect(html).not.toContain('secreto')
    expect(html).not.toContain('fake a')
  })

  it('exceptuar `/` no abre el resto: los endpoints siguen pidiendo auth', async () => {
    expect((await app().request('/v1/provider')).status).toBe(401)
    expect((await app().request('/v1/capacity')).status).toBe(401)
  })
})

describe('admisión editable', () => {
  const auth = { authorization: 'Bearer secret' }
  // `runReq` del bloque de capacidad vive en su propio scope — este es el
  // mismo helper, local a este describe.
  const postRun = (body: ProviderInput) => ({
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (body: unknown) => ({
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  function appWithState() {
    const saved: unknown[] = []
    const app = createApp({
      provider: fakeProvider(async () => ({ ok: true })),
      token: 'secret',
      log: silentLog(),
      state: {
        registerServerUrls: [],
        providerId: null,
        maxConcurrentRuns: null,
        admissionRules: [],
      },
      onStateChange: (s) => {
        saved.push(structuredClone(s))
      },
    })
    return { app, saved }
  }

  it('una regla guardada rechaza el run con 503 — diferido, no fallado', async () => {
    const { app } = appWithState()
    await app.request(
      '/v1/admission',
      json({ rules: [{ field: 'repo', op: 'equals', value: 'permitido' }] }),
    )

    const res = await app.request('/v1/run', postRun(baseInput({ repos: ['otro'] })))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('repo')
  })

  it('la misma regla deja pasar el repo que sí', async () => {
    const { app } = appWithState()
    await app.request(
      '/v1/admission',
      json({ rules: [{ field: 'repo', op: 'equals', value: 'permitido' }] }),
    )
    const res = await app.request('/v1/run', postRun(baseInput({ repos: ['permitido'] })))
    expect(res.status).toBe(200)
  })

  it('la sonda sin pistas no rechaza; con la pista equivocada sí', async () => {
    const { app } = appWithState()
    await app.request(
      '/v1/admission',
      json({ rules: [{ field: 'repo', op: 'equals', value: 'permitido' }] }),
    )
    expect((await (await app.request('/v1/capacity', { headers: auth })).json()).accepting).toBe(
      true,
    )
    const probed = await app.request('/v1/capacity?repo=otro', { headers: auth })
    expect((await probed.json()).accepting).toBe(false)
  })

  it('guarda el cambio para que sobreviva al reinicio, y 0 se normaliza a null', async () => {
    const { app, saved } = appWithState()
    await app.request('/v1/admission', json({ maxConcurrentRuns: 0 }))
    expect((saved.at(-1) as { maxConcurrentRuns: number | null }).maxConcurrentRuns).toBeNull()
  })

  it('rechaza reglas mal formadas en vez de guardarlas', async () => {
    const { app, saved } = appWithState()
    const res = await app.request('/v1/admission', json({ rules: [{ field: 'inventado' }] }))
    expect(res.status).toBe(400)
    expect(saved).toHaveLength(0)
  })
})

describe('registro editable', () => {
  const auth = { authorization: 'Bearer secret' }

  function appWithRegistry() {
    const registered: string[][] = []
    const unregistered: string[] = []
    const app = createApp({
      provider: fakeProvider(async () => ({})),
      token: 'secret',
      log: silentLog(),
      state: {
        registerServerUrls: [],
        providerId: null,
        maxConcurrentRuns: null,
        admissionRules: [],
      },
      registerTo: async (urls) => {
        registered.push(urls)
        return urls.map((serverUrl) => ({ serverUrl, ok: true }))
      },
      unregisterFrom: async (url) => {
        unregistered.push(url)
      },
    })
    return { app, registered, unregistered }
  }

  it('agregar un server lo da de alta y lo recuerda', async () => {
    const { app, registered } = appWithRegistry()
    const res = await app.request('/v1/registrations', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ serverUrl: 'http://localhost:3011' }),
    })
    const body = (await res.json()) as { serverUrls: string[]; registration: { ok: boolean } }
    expect(body.serverUrls).toEqual(['http://localhost:3011'])
    expect(body.registration.ok).toBe(true)
    expect(registered).toEqual([['http://localhost:3011']])
  })

  it('quitar un server lo da de baja aunque no estuviera en la lista', async () => {
    const { app, unregistered } = appWithRegistry()
    const res = await app.request('/v1/registrations?serverUrl=http://otro', {
      method: 'DELETE',
      headers: auth,
    })
    expect(res.status).toBe(200)
    expect(unregistered).toEqual(['http://otro'])
  })

  it('sin serverUrl no adivina: 400', async () => {
    const { app } = appWithRegistry()
    expect(
      (await app.request('/v1/registrations', { method: 'DELETE', headers: auth })).status,
    ).toBe(400)
  })
})

describe('registrar contra algo que no es un server', () => {
  it('responde 400 y NO recuerda la URL — reintentarla no cambiaría nada', async () => {
    const saved: unknown[] = []
    const app = createApp({
      provider: fakeProvider(async () => ({})),
      token: 'secret',
      log: silentLog(),
      state: {
        registerServerUrls: [],
        providerId: null,
        maxConcurrentRuns: null,
        admissionRules: [],
      },
      onStateChange: (s) => {
        saved.push(structuredClone(s))
      },
      registerTo: async (urls) =>
        urls.map((serverUrl) => ({
          serverUrl,
          ok: false,
          notAServer: true,
          reason: 'no parece un server',
        })),
    })

    const res = await app.request('/v1/registrations', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ serverUrl: 'http://localhost:3002' }),
    })

    expect(res.status).toBe(400)
    expect((await res.json()).serverUrls).toEqual([])
    expect(saved).toHaveLength(0)
  })
})

describe('sesiones async sobre HTTP', () => {
  const auth = { authorization: 'Bearer secret' }

  function appWithSession(handle: Partial<SessionHandle> = {}) {
    const closed: string[] = []
    const session: SessionHandle = {
      kind: 'tmux',
      id: 'sess-1',
      isAlive: async () => true,
      close: async () => {
        closed.push('sess-1')
      },
      ...handle,
    }
    const app = createApp({
      provider: fakeProvider(async () => ({ content: '', mode: 'tmux', session })),
      token: 'secret',
      log: silentLog(),
    })
    return { app, closed }
  }

  async function startRun(app: Hono) {
    return app.request('/v1/run', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(baseInput()),
    })
  }

  it('la respuesta lleva las coordenadas: las funciones no cruzan HTTP', async () => {
    const { app } = appWithSession()
    const body = (await (await startRun(app)).json()) as { session?: Record<string, unknown> }
    expect(body.session).toEqual({ kind: 'tmux', id: 'sess-1' })
  })

  it('el daemon puede sondear si sigue viva', async () => {
    const { app } = appWithSession()
    await startRun(app)
    const res = await app.request('/v1/sessions/sess-1', { headers: auth })
    expect(await res.json()).toEqual({ alive: true, known: true })
  })

  it('una sesión que no conocemos se reporta muerta, no 404', async () => {
    // Pasa de verdad si el gateway reinició mientras la sesión corría: para el
    // watchdog "no existe" y "murió" llevan a la misma decisión.
    const { app } = appWithSession()
    const res = await app.request('/v1/sessions/fantasma', { headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ alive: false, known: false })
  })

  it('un isAlive que lanza se lee como muerta en vez de romper la sonda', async () => {
    const { app } = appWithSession({
      isAlive: async () => {
        throw new Error('tmux no responde')
      },
    })
    await startRun(app)
    expect(await (await app.request('/v1/sessions/sess-1', { headers: auth })).json()).toEqual({
      alive: false,
      known: true,
    })
  })

  it('cerrarla llama al close del provider y la olvida', async () => {
    const { app, closed } = appWithSession()
    await startRun(app)

    await app.request('/v1/sessions/sess-1', { method: 'DELETE', headers: auth })

    expect(closed).toEqual(['sess-1'])
    // Y una segunda baja no explota: `close` es idempotente por contrato.
    const again = await app.request('/v1/sessions/sess-1', { method: 'DELETE', headers: auth })
    expect(again.status).toBe(200)
  })

  it('las sesiones también piden auth', async () => {
    const { app } = appWithSession()
    expect((await app.request('/v1/sessions/sess-1')).status).toBe(401)
  })
})

describe('cómo vuelve el agente al daemon', () => {
  const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }

  function appRegisteredAt(serverUrls: string[]) {
    let seen: ProviderInput | undefined
    const app = createApp({
      provider: fakeProvider(async (input) => {
        seen = input
        return { content: '', mode: 'api' as const }
      }),
      token: 'secret',
      log: silentLog(),
      state: {
        registerServerUrls: serverUrls,
        providerId: null,
        maxConcurrentRuns: null,
        admissionRules: [],
      },
    })
    return { app, seen: () => seen }
  }

  async function run(app: Hono, daemonUrl?: string) {
    await app.request('/v1/run', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ...baseInput(), daemonUrl }),
    })
  }

  it('usa la URL con la que se registró — la única que sabemos que funciona desde acá', async () => {
    const { app, seen } = appRegisteredAt(['http://localhost:3011'])
    // El server manda su localhost, que desde esta máquina es otra cosa.
    await run(app, 'http://localhost:3001')
    expect(seen()?.daemonUrl).toBe('http://localhost:3011')
  })

  it('con varios servers no adivina: respeta la que mandó el server', async () => {
    const { app, seen } = appRegisteredAt(['http://a:3011', 'http://b:3020'])
    await run(app, 'http://desde-el-server:3001')
    expect(seen()?.daemonUrl).toBe('http://desde-el-server:3001')
  })

  it('sin registraciones tampoco inventa', async () => {
    const { app, seen } = appRegisteredAt([])
    await run(app, 'http://desde-el-server:3001')
    expect(seen()?.daemonUrl).toBe('http://desde-el-server:3001')
  })
})

describe('GET /v1/logs', () => {
  const auth = { authorization: 'Bearer secret' }
  const dir = mkdtempSync(join(tmpdir(), 'gw-app-log-'))

  function entry(msg: string, extra: Record<string, unknown> = {}) {
    return JSON.stringify({ level: 30, time: '2026-08-24T22:00:00.000Z', msg, ...extra })
  }

  it('pide auth como el resto de /v1', async () => {
    const app = createApp({ provider: noopProvider, token: 'secret', log: silentLog() })
    expect((await app.request('/v1/logs')).status).toBe(401)
  })

  it('sin archivo configurado responde file: null, no un error', async () => {
    const app = createApp({ provider: noopProvider, token: 'secret', log: silentLog() })
    const res = await app.request('/v1/logs', { headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ file: null, lines: [], truncated: false })
  })

  it('devuelve el final del archivo', async () => {
    const file = join(dir, 'a.log')
    await Bun.write(file, [entry('uno'), entry('dos')].join('\n'))
    const app = createApp({
      provider: noopProvider,
      token: 'secret',
      log: silentLog(),
      logFile: file,
    })
    const body = (await (await app.request('/v1/logs', { headers: auth })).json()) as {
      lines: Array<{ msg?: string }>
    }
    expect(body.lines.map((l) => l.msg)).toEqual(['uno', 'dos'])
  })

  // El filtro corre sobre el ARCHIVO, no sobre lo que el limit ya recortó:
  // es toda la razón de que este endpoint exista en vez de filtrar en el
  // navegador.
  it('el filtro alcanza líneas más viejas que el limit', async () => {
    const file = join(dir, 'b.log')
    const noisy = [entry('el error viejo'), ...Array.from({ length: 30 }, () => entry('ruido'))]
    await Bun.write(file, noisy.join('\n'))
    const app = createApp({
      provider: noopProvider,
      token: 'secret',
      log: silentLog(),
      logFile: file,
    })
    const body = (await (
      await app.request('/v1/logs?limit=5&q=error', { headers: auth })
    ).json()) as { lines: Array<{ msg?: string }> }
    expect(body.lines.map((l) => l.msg)).toEqual(['el error viejo'])
  })

  it('un limit basura cae al default en vez de romper', async () => {
    const file = join(dir, 'c.log')
    await Bun.write(file, entry('uno'))
    const app = createApp({
      provider: noopProvider,
      token: 'secret',
      log: silentLog(),
      logFile: file,
    })
    const res = await app.request('/v1/logs?limit=abc', { headers: auth })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { lines: unknown[] }).lines).toHaveLength(1)
  })
})
