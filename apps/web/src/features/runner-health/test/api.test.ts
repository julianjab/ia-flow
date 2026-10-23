import axios, { AxiosError, AxiosHeaders } from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkHealth, getLogs, getResources, probe } from '../api'

/** Un error de axios con ese status, como lo arma una respuesta real. */
function httpError(status: number): AxiosError {
  const headers = new AxiosHeaders()
  return new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_RESPONSE',
    undefined,
    undefined,
    {
      status,
      statusText: '',
      headers,
      config: { headers },
      data: { error: 'no' },
    },
  )
}

type Routes = Record<string, unknown | (() => unknown)>

/** `axios.get` contra un mapa de rutas: un valor es el body; un `AxiosError`, lo que lanza. */
function serve(routes: Routes) {
  return vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    if (!(url in routes)) throw httpError(404)
    const r = routes[url]
    const value = typeof r === 'function' ? (r as () => unknown)() : r
    if (value instanceof Error) throw value
    return { data: value }
  })
}

const INFO = {
  service: 'ia-flow-runner',
  version: '2.14.0',
  projects: [],
  github_login: { device_flow: true },
  assistant: true,
}
const RESOURCES = { runner: { at: '2026-10-20T12:00:00Z', worktrees: 3 }, hosts: [] }
const LOGS = {
  lines: [
    { seq: 4, time: '2026-10-20T12:00:00Z', level: 'error', scope: 'engine', message: 'boom' },
  ],
  last_seq: 9,
  capacity: 2000,
}

afterEach(() => vi.restoreAllMocks())

describe('runner-health api', () => {
  it('un endpoint que el runner no tiene (404 o 501) vuelve null', async () => {
    serve({ '/api/logs': httpError(501) })
    expect(await getResources()).toBeNull()
    expect(await getLogs()).toBeNull()
  })

  it('otro error no se traga', async () => {
    serve({ '/api/resources': httpError(500) })
    await expect(getResources()).rejects.toThrow('500')
  })

  it('getLogs manda sólo los parámetros que hay y valida la respuesta', async () => {
    const get = serve({ '/api/logs': LOGS })
    const page = await getLogs({ level: 'warn', after: 3, limit: 8 })
    expect(page?.last_seq).toBe(9)
    expect(get).toHaveBeenCalledWith('/api/logs', { params: { level: 'warn', after: 3, limit: 8 } })
    await getLogs()
    expect(get).toHaveBeenLastCalledWith('/api/logs', { params: {} })
  })

  it('probe: /health {ok: true} alcanza', async () => {
    const get = serve({ '/health': { ok: true } })
    await probe()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('probe: detrás del proxy /health devuelve la página; prueba /api/runner', async () => {
    const get = serve({ '/health': '<!doctype html>', '/api/runner': INFO })
    await probe()
    expect(get.mock.calls.map((c) => c[0])).toEqual(['/health', '/api/runner'])
  })

  it('checkHealth: arma todo y deja vacío lo que falta', async () => {
    serve({
      '/health': { ok: true },
      '/api/runner': INFO,
      '/api/webhooks/status': {
        endpoint: '/x',
        secretConfigured: true,
        executions: { running: 1, waiting: 0, paused: 0 },
      },
      '/api/ingress': httpError(500),
      '/api/resources': RESOURCES,
    })
    const h = await checkHealth()
    expect(h.alive).toBe(true)
    expect(h.latencyMs).toBeGreaterThanOrEqual(0)
    expect(h.info?.version).toBe('2.14.0')
    expect(h.webhooks).toEqual({
      secretConfigured: true,
      executions: { running: 1, waiting: 0, paused: 0 },
    })
    // Falló esta vez: no se sabe.
    expect(h.ingress).toBeUndefined()
    expect(h.resources?.runner.worktrees).toBe(3)
    // Runner viejo: no lo expone.
    expect(h.problems).toBeNull()
  })

  it('checkHealth: con /api/logs, los avisos', async () => {
    serve({ '/health': { ok: true }, '/api/logs': LOGS })
    const h = await checkHealth()
    expect(h.problems?.map((l) => l.message)).toEqual(['boom'])
  })

  it('checkHealth: si no responde, no pide lo demás y dice por qué', async () => {
    const get = serve({ '/health': new Error('Network Error') })
    const h = await checkHealth()
    expect(h).toMatchObject({ alive: false, failure: 'Network Error' })
    expect(get).toHaveBeenCalledTimes(1)
  })
})
