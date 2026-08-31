import axios from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { probeServer } from '../api'

vi.mock('axios', () => ({
  default: { get: vi.fn(), isAxiosError: (e: unknown) => !!e && typeof e === 'object' },
}))

const get = vi.mocked(axios.get)

/** Un fallo con respuesta HTTP — lo que devuelve axios ante un 404/401. */
function httpError(status: number) {
  return Object.assign(new Error(`status ${status}`), { response: { status } })
}

/** Un fallo SIN respuesta — el host no existe o está apagado. */
function networkError() {
  return new Error('ECONNREFUSED')
}

const BASE = 'http://localhost:3012'

describe('probeServer', () => {
  beforeEach(() => {
    // Con cuerpo de bloque a propósito: `() => get.mockReset()` devuelve el
    // mock, y vitest toma lo que devuelve un `beforeEach` como su teardown —
    // o sea que al terminar cada test LLAMABA al mock, con `url` undefined.
    get.mockReset()
  })

  it('un server es lo que contesta /api/projects', async () => {
    get.mockImplementation(async (url) => {
      if (String(url).endsWith('/api/projects')) return { data: { projects: [{ id: 'p1' }] } }
      return { data: { registrations: [] } }
    })

    const probed = await probeServer(BASE)

    expect(probed.kind).toBe('server')
    expect(probed.reachable).toBe(true)
    expect(probed.projects).toHaveLength(1)
  })

  it('un server sano cuesta las requests de siempre — no se sondea /v1 al pedo', async () => {
    // Si el camino feliz empezara probando los dos tipos, cada scan duplicaría
    // las requests contra cada server declarado.
    get.mockImplementation(async (url) => {
      if (String(url).endsWith('/api/projects')) return { data: { projects: [] } }
      return { data: { registrations: [] } }
    })

    await probeServer(BASE)

    const called = get.mock.calls.map((c) => String(c[0]))
    expect(called.some((u) => u.includes('/v1/'))).toBe(false)
  })

  it('un 404 en /api/projects no es "no responde": es un agent-host', async () => {
    // El bug exacto que motivó esto. Un agent-host sano devolvía 404 —no tiene
    // esa ruta, su API es /v1/*— y la tarjeta lo dibujaba igual que un
    // container apagado.
    get.mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/api/projects')) throw httpError(404)
      if (u.endsWith('/v1/provider'))
        return { data: { id: 'anthropic-api', name: 'Anthropic API' } }
      if (u.endsWith('/v1/capacity')) {
        return { data: { running: 2, maxConcurrentRuns: 4, accepting: true } }
      }
      throw httpError(404)
    })

    const probed = await probeServer(BASE, 'tok')

    expect(probed.kind).toBe('agent-host')
    expect(probed.reachable).toBe(true)
    expect(probed.agentHost).toEqual({
      providerId: 'anthropic-api',
      providerName: 'Anthropic API',
      running: 2,
      maxConcurrentRuns: 4,
      accepting: true,
    })
  })

  it('un 401 dice de qué tipo es igual — el arreglo está en otra pantalla', async () => {
    // `GET /` del agent-host está fuera de su guard justamente para esto: sin
    // credencial válida no hay forma de saber qué hay del otro lado, y "pide
    // token" a secas no dice dónde configurarlo.
    get.mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/api/projects')) throw httpError(401)
      if (u === `${BASE}/`) return { data: { service: 'agent-host' } }
      throw httpError(404)
    })

    const probed = await probeServer(BASE)

    expect(probed.needsToken).toBe(true)
    expect(probed.kind).toBe('agent-host')
    expect(probed.reachable).toBe(false)
  })

  it('un host caído no se sondea dos veces', async () => {
    // Sin respuesta HTTP no hay nadie del otro lado. Reintentar contra /v1/*
    // sólo duplicaría el ERR_CONNECTION_REFUSED inatrapable de la consola.
    get.mockImplementation(async () => {
      throw networkError()
    })

    const probed = await probeServer(BASE)

    expect(probed.kind).toBe('unknown')
    expect(probed.reachable).toBe(false)
    expect(probed.needsToken).toBe(false)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('un agent-host que contesta /v1 pero no /v1/capacity no se da por vivo', async () => {
    // Media lectura no alcanza: la tarjeta muestra ocupación, y un agent-host
    // "vivo" sin ese dato es peor que uno marcado como caído.
    get.mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/v1/provider')) return { data: { id: 'x', name: 'X' } }
      throw httpError(500)
    })

    const probed = await probeServer(BASE)

    expect(probed.reachable).toBe(false)
    expect(probed.agentHost).toBeNull()
  })
})
