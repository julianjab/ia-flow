import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadServers, parseServers, saveServers } from '../storage'

/** Simula el puente que expone la app de escritorio. */
function installBridge(initial: unknown[] = []) {
  let file = initial
  const bridge = {
    loadServers: vi.fn(async () => file),
    saveServers: vi.fn(async (servers: unknown) => {
      file = servers as unknown[]
    }),
  }
  ;(globalThis as Record<string, unknown>).iaFlowDesktop = bridge
  return { bridge, read: () => file }
}

function removeBridge() {
  ;(globalThis as Record<string, unknown>).iaFlowDesktop = undefined
}

describe('storage de servers', () => {
  beforeEach(() => {
    localStorage.clear()
    removeBridge()
  })

  it('sin puente usa localStorage', async () => {
    await saveServers([{ baseUrl: 'http://a:1' }])
    expect(await loadServers()).toEqual([{ baseUrl: 'http://a:1' }])
  })

  it('con puente escribe en los DOS lados', async () => {
    const { read } = installBridge()
    await saveServers([{ baseUrl: 'http://a:1', token: 't' }])

    expect(read()).toHaveLength(1)
    removeBridge()
    // Sin puente, la lista sigue estando: por eso se escribe en ambos.
    expect(await loadServers()).toEqual([{ baseUrl: 'http://a:1', token: 't' }])
  })

  it('lo guardado SIN puente no se pierde cuando el puente aparece', async () => {
    // Este es el síntoma reportado: "agrego servers, entro a uno, vuelvo y no
    // están". El backend cambia entre arranques —la app expone el puente sólo
    // cuando pudo verificar quién sirve la página— y leer sólo por el puente
    // devolvía vacío aunque los servers estuvieran en localStorage.
    await saveServers([{ baseUrl: 'http://local:1', token: 'tok' }])

    installBridge([])
    const loaded = await loadServers()

    expect(loaded).toEqual([{ baseUrl: 'http://local:1', token: 'tok' }])
  })

  it('y los sube al archivo, así la próxima lectura ya no depende del backend', async () => {
    await saveServers([{ baseUrl: 'http://local:1' }])
    const { read } = installBridge([])

    await loadServers()

    expect(read()).toEqual([{ baseUrl: 'http://local:1' }])
  })

  it('ante el mismo baseUrl gana el archivo', async () => {
    await saveServers([{ baseUrl: 'http://a:1', token: 'viejo' }])
    installBridge([{ baseUrl: 'http://a:1', token: 'nuevo' }])

    expect(await loadServers()).toEqual([{ baseUrl: 'http://a:1', token: 'nuevo' }])
  })

  it('un puente que falla no deja al usuario sin lista', async () => {
    await saveServers([{ baseUrl: 'http://a:1' }])
    ;(globalThis as Record<string, unknown>).iaFlowDesktop = {
      loadServers: vi.fn(async () => {
        throw new Error('IPC caído')
      }),
      saveServers: vi.fn(),
    }

    expect(await loadServers()).toEqual([{ baseUrl: 'http://a:1' }])
  })
})

describe('parseServers', () => {
  it('descarta entradas rotas en vez de tirar', () => {
    // Entrada no confiable: un archivo editado a mano, o un schema viejo.
    expect(parseServers([null, 42, {}, { baseUrl: '' }, { baseUrl: 'a:1' }])).toEqual([
      { baseUrl: 'http://a:1' },
    ])
  })

  it('normaliza el esquema y la barra final', () => {
    expect(parseServers([{ baseUrl: '192.168.1.9:3001/' }])).toEqual([
      { baseUrl: 'http://192.168.1.9:3001' },
    ])
  })

  it('no admite dos entradas con la misma baseUrl', () => {
    expect(
      parseServers([
        { baseUrl: 'http://a:1', token: 'primero' },
        { baseUrl: 'http://a:1', token: 'segundo' },
      ]),
    ).toHaveLength(1)
  })
})
