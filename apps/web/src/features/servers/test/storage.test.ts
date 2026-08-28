import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadServers, parseServers, saveServers } from '../storage'

/** Simula el puente que expone la app de escritorio. */
function installBridge(initial: unknown = null) {
  let file = initial
  const bridge = {
    loadServers: vi.fn(async () => file),
    saveServers: vi.fn(async (payload: unknown) => {
      file = payload
    }),
  }
  ;(globalThis as Record<string, unknown>).iaFlowDesktop = bridge
  return { bridge, read: () => file as { rev: number; servers: unknown[] } | null }
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

    expect(read()?.servers).toHaveLength(1)
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

    installBridge(null)
    const loaded = await loadServers()

    expect(loaded).toEqual([{ baseUrl: 'http://local:1', token: 'tok' }])
  })

  it('y los sube al archivo, así la próxima lectura ya no depende del backend', async () => {
    await saveServers([{ baseUrl: 'http://local:1' }])
    const { read } = installBridge(null)

    await loadServers()

    expect(read()?.servers).toEqual([{ baseUrl: 'http://local:1' }])
  })

  it('gana la escritura MÁS NUEVA, no la unión', async () => {
    // El archivo tiene una revisión vieja; localStorage una más nueva.
    installBridge({ rev: 1, servers: [{ baseUrl: 'http://a:1', token: 'viejo' }] })
    await saveServers([{ baseUrl: 'http://a:1', token: 'nuevo' }])

    expect(await loadServers()).toEqual([{ baseUrl: 'http://a:1', token: 'nuevo' }])
  })

  it('BORRAR se propaga — un server eliminado no resucita', async () => {
    // La contracara del bug anterior: unir local+archivo hacía imposible
    // borrar, porque el lado que todavía tenía la entrada la revivía. Con una
    // revisión, la lista más nueva manda aunque sea MÁS CORTA.
    installBridge({ rev: 1, servers: [{ baseUrl: 'http://a:1' }, { baseUrl: 'http://b:2' }] })
    removeBridge()
    // Sin puente, el usuario borra uno: sólo se actualiza localStorage.
    await saveServers([{ baseUrl: 'http://a:1' }])

    installBridge({ rev: 1, servers: [{ baseUrl: 'http://a:1' }, { baseUrl: 'http://b:2' }] })
    expect(await loadServers()).toEqual([{ baseUrl: 'http://a:1' }])
  })

  it('borrar TODO también se propaga', async () => {
    installBridge({ rev: 1, servers: [{ baseUrl: 'http://a:1' }] })
    removeBridge()
    await saveServers([])

    installBridge({ rev: 1, servers: [{ baseUrl: 'http://a:1' }] })
    expect(await loadServers()).toEqual([])
  })

  it('lee el formato viejo (un array pelado) como la revisión más vieja', async () => {
    installBridge([{ baseUrl: 'http://viejo:1' }])
    expect(await loadServers()).toEqual([{ baseUrl: 'http://viejo:1' }])
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
