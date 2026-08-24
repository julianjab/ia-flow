import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProbedServer } from '../api'

const probeServer = vi.fn<(url: string) => Promise<ProbedServer>>()

vi.mock('@/features/servers/api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return { ...actual, probeServer: (url: string) => probeServer(url) }
})

function reply(url: string, reachable: boolean): ProbedServer {
  return { baseUrl: url, reachable, latencyMs: 1, projects: [], remoteProviders: [] }
}

describe('useServersStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    probeServer.mockReset()
    vi.resetModules()
  })

  it('el barrido de puertos sólo deja los que respondieron', async () => {
    probeServer.mockImplementation(async (url) => reply(url, url.endsWith(':3011')))
    const { useServersStore } = await import('../store')
    const store = useServersStore()

    await store.sweepPorts()

    expect(store.servers.map((s) => s.baseUrl)).toContain('http://localhost:3011')
    expect(store.servers.some((s) => s.baseUrl === 'http://localhost:3012')).toBe(false)
  })

  it('la primera visita barre; las siguientes sondean sólo lo aprendido', async () => {
    probeServer.mockImplementation(async (url) => reply(url, url.endsWith(':3011')))
    const { useServersStore } = await import('../store')
    const store = useServersStore()

    await store.scan() // sin nada conocido → cae al barrido
    const sweptCalls = probeServer.mock.calls.length
    expect(sweptCalls).toBeGreaterThan(10)

    probeServer.mockClear()
    await store.scan()

    // Ya no barre: sólo el actual + el que aprendió.
    expect(probeServer.mock.calls.length).toBeLessThan(4)
    expect(store.servers.some((s) => s.baseUrl === 'http://localhost:3011')).toBe(true)
  })

  it('un server agregado a mano sigue en la lista aunque no responda', async () => {
    probeServer.mockImplementation(async (url) => reply(url, false))
    const { useServersStore } = await import('../store')
    const store = useServersStore()

    await store.addUrl('localhost:3030')
    await store.sweepPorts()

    const added = store.servers.find((s) => s.baseUrl === 'http://localhost:3030')
    expect(added?.reachable).toBe(false)
  })

  it('addUrl normaliza el esquema y no duplica', async () => {
    probeServer.mockImplementation(async (url) => reply(url, true))
    const { useServersStore } = await import('../store')
    const store = useServersStore()

    await store.addUrl('localhost:3030/')
    await store.addUrl('http://localhost:3030')

    expect(store.pinnedUrls).toEqual(['http://localhost:3030'])
  })

  it('los agregados a mano sobreviven al reload — van a localStorage', async () => {
    probeServer.mockImplementation(async (url) => reply(url, true))
    const first = await import('../store')
    await first.useServersStore().addUrl('localhost:3030')

    vi.resetModules()
    setActivePinia(createPinia())
    const second = await import('../store')

    expect(second.useServersStore().pinnedUrls).toEqual(['http://localhost:3030'])
  })

  it('quitar un server lo saca de la lista y del storage', async () => {
    probeServer.mockImplementation(async (url) => reply(url, true))
    const { useServersStore } = await import('../store')
    const store = useServersStore()

    await store.addUrl('localhost:3030')
    store.removeUrl('http://localhost:3030')

    expect(store.pinnedUrls).toEqual([])
    expect(store.servers.some((s) => s.baseUrl === 'http://localhost:3030')).toBe(false)
  })
})
