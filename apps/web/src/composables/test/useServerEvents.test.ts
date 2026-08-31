// El flag `enabled` del socket compartido.

import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useServerEvents } from '../useServerEvents'

class FakeSocket {
  static opened: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  readyState = 0
  constructor(url: string) {
    FakeSocket.opened.push(url)
  }
  close() {
    this.readyState = 3
  }
}

function host(handler = () => {}, opts?: { enabled?: boolean }) {
  return mount({
    setup() {
      useServerEvents(handler, opts)
      return () => null
    },
  })
}

describe('useServerEvents', () => {
  beforeEach(() => {
    FakeSocket.opened = []
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sin opciones abre el socket, como siempre', () => {
    host()
    expect(FakeSocket.opened).toHaveLength(1)
  })

  it('`enabled: false` NO abre el socket', () => {
    // El bug que esto cierra: cortar adentro del handler descarta los mensajes
    // pero el socket se abre igual, cierra contra un proceso que no tiene /ws,
    // y el composable reintenta con backoff para siempre.
    host(() => {}, { enabled: false })
    expect(FakeSocket.opened).toHaveLength(0)
  })

  it('un handler deshabilitado no cierra el socket de los demás al desmontarse', () => {
    const alive = host()
    const off = host(() => {}, { enabled: false })

    off.unmount()

    expect(FakeSocket.opened).toHaveLength(1)
    alive.unmount()
  })
})
