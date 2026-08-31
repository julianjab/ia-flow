import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProbedServer } from '../api'

const probeServer = vi.fn<(url: string, token?: string) => Promise<ProbedServer>>()

vi.mock('@/features/servers/api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return { ...actual, probeServer: (url: string, token?: string) => probeServer(url, token) }
})

function reply(url: string, over: Partial<ProbedServer> = {}): ProbedServer {
  return {
    baseUrl: url,
    kind: 'server',
    reachable: true,
    needsToken: false,
    latencyMs: 1,
    projects: [],
    remoteProviders: [],
    agentHost: null,
    ...over,
  }
}

describe('useServersStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    probeServer.mockReset()
    probeServer.mockImplementation(async (url) => reply(url))
    vi.resetModules()
  })

  it('la lista arranca vacía — no se descubre nada', async () => {
    // El contrato central del cambio: sin servers declarados no hay servers.
    // Antes esto barría 17 puertos y "encontraba" lo que hubiera escuchando.
    const { useServersStore } = await import('../store')
    const store = useServersStore()

    await store.init()

    expect(store.servers).toHaveLength(0)
    expect(store.empty).toBe(true)
    expect(probeServer).not.toHaveBeenCalled()
  })

  it('agrega un server, lo persiste y lo sondea', async () => {
    const { useServersStore } = await import('../store')
    const store = useServersStore()
    await store.init()

    const added = await store.addServer('localhost:3030', 'tok')

    expect(added).toBe(true)
    expect(store.servers.map((s) => s.baseUrl)).toEqual(['http://localhost:3030'])
    // El token viaja al sondeo: sin eso, un server protegido se vería caído.
    expect(probeServer).toHaveBeenCalledWith('http://localhost:3030', 'tok')
  })

  it('no agrega dos veces la misma URL', async () => {
    const { useServersStore } = await import('../store')
    const store = useServersStore()
    await store.init()

    expect(await store.addServer('localhost:3030')).toBe(true)
    // La baseUrl es la identidad: dos entradas iguales dejarían al usuario
    // editando una y viendo la otra.
    expect(await store.addServer('http://localhost:3030/')).toBe(false)
    expect(store.servers).toHaveLength(1)
  })

  it('la lista sobrevive a recargar', async () => {
    const first = await import('../store')
    setActivePinia(createPinia())
    const store = first.useServersStore()
    await store.init()
    await store.addServer('localhost:3030', 'tok')

    vi.resetModules()
    setActivePinia(createPinia())
    const second = await import('../store')
    const reloaded = second.useServersStore()
    await reloaded.init()

    expect(reloaded.servers.map((s) => s.baseUrl)).toEqual(['http://localhost:3030'])
    expect(reloaded.tokenFor('http://localhost:3030')).toBe('tok')
  })

  it('cambiar el token lo persiste y vuelve a sondear con el nuevo', async () => {
    const { useServersStore } = await import('../store')
    const store = useServersStore()
    await store.init()
    await store.addServer('localhost:3030', 'viejo')
    probeServer.mockClear()

    await store.updateServer('http://localhost:3030', { token: 'nuevo' })

    expect(store.tokenFor('http://localhost:3030')).toBe('nuevo')
    expect(probeServer).toHaveBeenCalledWith('http://localhost:3030', 'nuevo')
  })

  it('un 401 se refleja como needsToken, no como caído', async () => {
    probeServer.mockImplementation(async (url) =>
      reply(url, { reachable: false, needsToken: true }),
    )
    const { useServersStore } = await import('../store')
    const store = useServersStore()
    await store.init()
    await store.addServer('localhost:3030')

    // Son dos arreglos distintos: uno se levanta, el otro se configura.
    expect(store.servers[0]?.needsToken).toBe(true)
    expect(store.reachable).toHaveLength(0)
  })

  it('quitar un server lo saca de la lista y del storage', async () => {
    const { useServersStore } = await import('../store')
    const store = useServersStore()
    await store.init()
    await store.addServer('localhost:3030')

    await store.removeServer('http://localhost:3030')

    expect(store.servers).toHaveLength(0)
    expect(store.saved).toHaveLength(0)
  })
})
