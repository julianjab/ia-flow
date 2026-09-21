import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevProcStatus } from '../api'
import DevctlPanel from '../DevctlPanel.vue'

function makeStatuses(): DevProcStatus[] {
  return [
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
    {
      id: 'web',
      label: 'Web',
      defaultPort: 5173,
      managed: false,
      portOpen: false,
      mode: null,
      port: null,
      pid: null,
      startedAt: null,
      lastExit: null,
    },
    {
      id: 'agent-host-fe',
      label: 'Agent Host · frontend',
      defaultPort: 3002,
      managed: false,
      portOpen: false,
      mode: null,
      port: null,
      pid: null,
      startedAt: null,
      lastExit: null,
    },
    {
      id: 'agent-host-be',
      label: 'Agent Host · backend e2e',
      defaultPort: 3003,
      managed: false,
      portOpen: false,
      mode: null,
      port: null,
      pid: null,
      startedAt: null,
      lastExit: null,
    },
  ]
}

function installBridge() {
  const bridge = {
    status: vi.fn(async () => makeStatuses()),
    logs: vi.fn(async () => []),
    start: vi.fn(async () => ({ ok: true }) as const),
    stop: vi.fn(async () => ({ ok: true }) as const),
  }
  ;(globalThis as Record<string, unknown>).iaFlowDesktop = { devctl: bridge }
  return bridge
}

function removeBridge() {
  ;(globalThis as Record<string, unknown>).iaFlowDesktop = undefined
}

describe('DevctlPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })
  afterEach(() => {
    removeBridge()
    vi.useRealTimers()
  })

  it('sin puente muestra que el panel no está disponible', async () => {
    const wrapper = mount(DevctlPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('app de escritorio')
    wrapper.unmount()
  })

  it('con puente, renderiza las 4 cards con lo que devuelve el status', async () => {
    installBridge()
    const wrapper = mount(DevctlPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Server')
    expect(wrapper.text()).toContain('Web')
    expect(wrapper.text()).toContain('Agent Host · frontend')
    expect(wrapper.text()).toContain('Agent Host · backend e2e')
    wrapper.unmount()
  })

  it('start en una card llama a startProcess con los valores elegidos', async () => {
    const bridge = installBridge()
    const wrapper = mount(DevctlPanel)
    await flushPromises()

    await wrapper.findAll('input[type="number"]')[0]!.setValue(4001)
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'levantar')!
      .trigger('click')
    await flushPromises()

    expect(bridge.start).toHaveBeenCalledWith('server', 'dev', 4001)
    wrapper.unmount()
  })

  it('stop en una card llama a stopProcess', async () => {
    const bridge = installBridge()
    bridge.status.mockResolvedValueOnce(
      makeStatuses().map((s, i) =>
        i === 0
          ? { ...s, managed: true, portOpen: true, mode: 'dev' as const, port: 3001, pid: 1 }
          : s,
      ),
    )
    const wrapper = mount(DevctlPanel)
    await flushPromises()

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('detener'))!
      .trigger('click')
    await flushPromises()

    expect(bridge.stop).toHaveBeenCalledWith('server')
    wrapper.unmount()
  })
})
