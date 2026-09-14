import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLogs, fetchStatus, isDevctlAvailable, startProcess, stopProcess } from '../api'

function installBridge() {
  const bridge = {
    status: vi.fn(async () => [
      {
        id: 'server',
        label: 'Server',
        defaultPort: 3001,
        managed: false,
        portOpen: false,
        mode: null,
        port: null,
        pid: null,
        startedAt: null,
        lastExit: null,
      },
    ]),
    logs: vi.fn(async () => ['línea 1']),
    start: vi.fn(async () => ({ ok: true }) as const),
    stop: vi.fn(async () => ({ ok: true }) as const),
  }
  ;(globalThis as Record<string, unknown>).iaFlowDesktop = { devctl: bridge }
  return bridge
}

function removeBridge() {
  ;(globalThis as Record<string, unknown>).iaFlowDesktop = undefined
}

describe('devctl api', () => {
  afterEach(() => removeBridge())

  it('sin puente, no está disponible y todo cae a valores vacíos', async () => {
    expect(isDevctlAvailable()).toBe(false)
    expect(await fetchStatus()).toEqual([])
    expect(await fetchLogs('server')).toEqual([])
    expect(await startProcess('server', 'dev', 3001)).toEqual({
      ok: false,
      error: 'devctl no disponible en este navegador',
    })
    expect(await stopProcess('server')).toEqual({
      ok: false,
      error: 'devctl no disponible en este navegador',
    })
  })

  it('con puente, delega cada llamada', async () => {
    const bridge = installBridge()

    expect(isDevctlAvailable()).toBe(true)
    await fetchStatus()
    expect(bridge.status).toHaveBeenCalled()

    await fetchLogs('web')
    expect(bridge.logs).toHaveBeenCalledWith('web')

    await startProcess('web', 'run', 5173)
    expect(bridge.start).toHaveBeenCalledWith('web', 'run', 5173)

    await stopProcess('web')
    expect(bridge.stop).toHaveBeenCalledWith('web')
  })
})
