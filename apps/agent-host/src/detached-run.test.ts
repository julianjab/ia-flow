import { describe, expect, it } from 'bun:test'
import type { IAgentProvider, ProviderInput } from '@ia-flow/ai-providers'
import type { Hono } from 'hono'
import { createApp } from './app.js'
import type { Log } from './logger.js'

function silentLog(): Log {
  const log: Log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  }
  return log
}

const AUTH = { authorization: 'Bearer secret', 'content-type': 'application/json' }

/** Un provider que termina cuando se lo pedimos, no cuando el handler vuelve. */
function controllableProvider() {
  let finish: (content: string) => void = () => {}
  let sawAbort = false
  const provider: IAgentProvider = {
    id: 'a',
    kind: 'sync',
    name: 'a',
    description: 'fake',
    run: (input: ProviderInput) =>
      new Promise((resolve, reject) => {
        finish = (content) => resolve({ content, mode: 'api', stopReason: 'end_turn' })
        input.signal?.addEventListener('abort', () => {
          sawAbort = true
          reject(new Error('abortado'))
        })
      }),
  }
  return { provider, finish: (c = 'listo') => finish(c), sawAbort: () => sawAbort }
}

function body(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    step: 'implement',
    taskId: 't1',
    taskTitle: 'x',
    taskDescription: '',
    taskType: 'functional',
    repos: [],
    repoPaths: {},
    prompt: 'hola',
    runId: 'run-1',
    ...overrides,
  }
}

function post(app: Hono, path: string, input: ProviderInput) {
  return app.request(path, { method: 'POST', headers: AUTH, body: JSON.stringify(input) })
}

describe('POST /v1/run?wait=poll — acepta y contesta', () => {
  it('devuelve 202 sin esperar a que el run termine', async () => {
    // El punto entero: un run dura minutos u horas y sostener el request todo
    // ese tiempo hacía que cualquier corte de red se leyera como un run
    // FALLIDO, con su onError comentando sobre trabajo que seguía avanzando.
    const { provider } = controllableProvider()
    const app = createApp({ provider, token: 'secret', log: silentLog() })

    const res = await post(app, '/v1/run?wait=poll', body())

    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ accepted: true, runId: 'run-1' })
  })

  it('sin el flag sigue colgando el output del request — un daemon viejo espera eso', async () => {
    const { provider, finish } = controllableProvider()
    const app = createApp({ provider, token: 'secret', log: silentLog() })

    const pending = post(app, '/v1/run', body())
    // El provider recién arranca tras el await de `resolveWorkspace`.
    await Bun.sleep(5)
    finish('inline')
    const res = await pending

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ content: 'inline' })
  })

  it('inventa un runId cuando el daemon no mandó uno', async () => {
    const { provider } = controllableProvider()
    const app = createApp({ provider, token: 'secret', log: silentLog() })

    const res = await post(app, '/v1/run?wait=poll', body({ runId: undefined }))

    expect((await res.json()).runId).toMatch(/^run-/)
  })
})

describe('GET /v1/runs/:id', () => {
  it('mientras corre dice `running`, y al terminar entrega el output', async () => {
    const { provider, finish } = controllableProvider()
    const app = createApp({ provider, token: 'secret', log: silentLog() })
    await post(app, '/v1/run?wait=poll', body())

    const running = await (await app.request('/v1/runs/run-1', { headers: AUTH })).json()
    finish('terminado')
    await Bun.sleep(5)
    const done = await (await app.request('/v1/runs/run-1', { headers: AUTH })).json()

    expect(running).toEqual({ status: 'running' })
    expect(done).toMatchObject({ status: 'done', output: { content: 'terminado' } })
  })

  it('el resultado se puede volver a cobrar — no se borra al entregarlo', async () => {
    // Si se borrara al leerlo, un corte entre el delete y el parseo del body
    // haría que el siguiente sondeo viera `unknown` y el daemon reportara
    // como FALLIDO un run que terminó bien: el mismo modo de falla del
    // request colgado, en una ventana más chica.
    const { provider, finish } = controllableProvider()
    const app = createApp({ provider, token: 'secret', log: silentLog() })
    await post(app, '/v1/run?wait=poll', body())
    finish('terminado')
    await Bun.sleep(5)

    await app.request('/v1/runs/run-1', { headers: AUTH })
    const segundo = await (await app.request('/v1/runs/run-1', { headers: AUTH })).json()

    expect(segundo).toMatchObject({ status: 'done', output: { content: 'terminado' } })
  })

  it('un run que nunca existió es `unknown`, no un 404', async () => {
    const { provider } = controllableProvider()
    const app = createApp({ provider, token: 'secret', log: silentLog() })

    const res = await app.request('/v1/runs/no-existe', { headers: AUTH })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'unknown' })
  })

  it('un provider que tira se reporta como `failed`, con el motivo', async () => {
    const provider: IAgentProvider = {
      id: 'a',
      kind: 'sync',
      name: 'a',
      description: 'f',
      run: async () => {
        throw new Error('el modelo explotó')
      },
    }
    const app = createApp({ provider, token: 'secret', log: silentLog() })

    await post(app, '/v1/run?wait=poll', body())
    await Bun.sleep(5)
    const res = await (await app.request('/v1/runs/run-1', { headers: AUTH })).json()

    expect(res).toMatchObject({ status: 'failed', error: 'el modelo explotó' })
  })
})

describe('un run que nadie viene a buscar', () => {
  it('se abandona y libera el slot — nadie va a mandar el DELETE', async () => {
    // El daemon sondea cada pocos segundos: dejar de preguntar sólo pasa si
    // murió, perdió la red, o ya dio el run por perdido. Sin esto ese run se
    // queda corriendo con su slot tomado para siempre, porque el único corte
    // era un DELETE que justamente nadie va a mandar.
    Bun.env.AGENT_HOST_ABANDONED_RUN_MS = '1'
    const { provider, sawAbort } = controllableProvider()
    const app = createApp({ provider, token: 'secret', log: silentLog() })
    await post(app, '/v1/run?wait=poll', body())

    await Bun.sleep(10)
    // Cualquier acceso corre el barrido — no hay timer que apagar.
    const res = await (await app.request('/v1/runs/run-1', { headers: AUTH })).json()
    await Bun.sleep(5)

    expect(res).toEqual({ status: 'unknown' })
    expect(sawAbort()).toBe(true)
    delete Bun.env.AGENT_HOST_ABANDONED_RUN_MS
  })

  it('libera la capacidad aunque nadie vuelva a pegarle a /v1/runs', async () => {
    // El wedge: con el cap en 1 y el daemon muerto, el único que sondeaba ese
    // run era él. Si el barrido sólo corriera en `/v1/runs/:id`, `running`
    // quedaba en 1 para siempre y TODO `POST /v1/run` —de ese daemon o de
    // otro— contestaba 503 indefinidamente.
    Bun.env.AGENT_HOST_ABANDONED_RUN_MS = '1'
    const { provider } = controllableProvider()
    const app = createApp({ provider, token: 'secret', log: silentLog(), maxConcurrentRuns: 1 })
    await post(app, '/v1/run?wait=poll', body())
    await Bun.sleep(10)

    // La primera sonda dispara el barrido; el slot se libera un tick después
    // (`running--` vive en el `finally` del run, que es su única fuente de
    // verdad). El daemon sondea en loop, así que la siguiente ya lo ve.
    await app.request('/v1/capacity', { headers: AUTH })
    await Bun.sleep(5)
    const cap = await (await app.request('/v1/capacity', { headers: AUTH })).json()
    const res = await post(app, '/v1/run?wait=poll', body({ runId: 'run-2' }))

    expect(cap).toMatchObject({ accepting: true, running: 0 })
    expect(res.status).toBe(202)
    delete Bun.env.AGENT_HOST_ABANDONED_RUN_MS
  })

  it('sondearlo lo mantiene vivo: el GET es el latido', async () => {
    Bun.env.AGENT_HOST_ABANDONED_RUN_MS = '60000'
    const { provider, sawAbort } = controllableProvider()
    const app = createApp({ provider, token: 'secret', log: silentLog() })
    await post(app, '/v1/run?wait=poll', body())

    await Bun.sleep(10)
    const res = await (await app.request('/v1/runs/run-1', { headers: AUTH })).json()

    expect(res).toEqual({ status: 'running' })
    expect(sawAbort()).toBe(false)
    delete Bun.env.AGENT_HOST_ABANDONED_RUN_MS
  })
})

describe('DELETE /v1/runs/:id', () => {
  it('aborta el run en vuelo — sin esto el CLI sigue trabajando', async () => {
    const { provider, sawAbort } = controllableProvider()
    const app = createApp({ provider, token: 'secret', log: silentLog() })
    await post(app, '/v1/run?wait=poll', body())

    const res = await app.request('/v1/runs/run-1', { method: 'DELETE', headers: AUTH })
    await Bun.sleep(5)

    expect(await res.json()).toMatchObject({ cancelled: true, known: true })
    expect(sawAbort()).toBe(true)
  })

  it('borra la entrada: quien cancela no vuelve a buscar el resultado', async () => {
    // El resto se limpia por TTL, pero acá se sabe que nadie va a venir.
    const { provider } = controllableProvider()
    const app = createApp({ provider, token: 'secret', log: silentLog() })
    await post(app, '/v1/run?wait=poll', body())

    await app.request('/v1/runs/run-1', { method: 'DELETE', headers: AUTH })
    await Bun.sleep(5)
    const res = await (await app.request('/v1/runs/run-1', { headers: AUTH })).json()

    expect(res).toEqual({ status: 'unknown' })
  })

  it('cancelar un run desconocido no es un error', async () => {
    const { provider } = controllableProvider()
    const app = createApp({ provider, token: 'secret', log: silentLog() })

    const res = await app.request('/v1/runs/otro', { method: 'DELETE', headers: AUTH })

    expect(await res.json()).toMatchObject({ cancelled: true, known: false })
  })
})
