import { useToastStore } from '@/stores/toast'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAbortRecord } from '../agent-aborts-api'

const listMock = vi.fn<[], Promise<AgentAbortRecord[]>>()
const retryMock = vi.fn()
vi.mock('../agent-aborts-api', () => ({
  listAgentAborts: () => listMock(),
  retryAgentAbort: (id: string) => retryMock(id),
}))

import AgentAbortsSection from '../AgentAbortsSection.vue'

function makeAbort(overrides: Partial<AgentAbortRecord> = {}): AgentAbortRecord {
  return {
    id: 'abort-1',
    projectId: 'proj-1',
    taskId: 'task-42',
    agentId: 'builder',
    runId: 'run-1',
    reason: 'stream-stall',
    errorMsg: 'upstream stalled after 60s without data',
    attempts: 1,
    maxAttempts: 5,
    status: 'pending',
    nextRetryAt: '2026-01-01T00:05:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    resolvedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  listMock.mockReset()
  retryMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentAbortsSection', () => {
  it('carga y muestra los runs abortados al montar', async () => {
    listMock.mockResolvedValueOnce([makeAbort()])
    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('task-42')
    expect(wrapper.text()).toContain('builder')
    expect(wrapper.text()).toContain('reintentando')
    expect(wrapper.text()).toContain('1/5 intentos')
    expect(wrapper.text()).toContain('upstream stalled after 60s without data')
  })

  it('muestra el estado vacío cuando no hay runs abortados', async () => {
    listMock.mockResolvedValueOnce([])
    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('Sin runs abortados pendientes.')
  })

  it('marca exhausted con su propio badge', async () => {
    listMock.mockResolvedValueOnce([makeAbort({ status: 'exhausted' })])
    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('agotado')
    expect(wrapper.find('.status-exhausted').exists()).toBe(true)
  })

  it('reintenta y recarga la lista al hacer click en Reintentar', async () => {
    listMock.mockResolvedValueOnce([makeAbort()])
    retryMock.mockResolvedValueOnce(undefined)
    listMock.mockResolvedValueOnce([])

    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    await wrapper.find('.entry-actions button').trigger('click')
    await flushPromises()

    expect(retryMock).toHaveBeenCalledWith('abort-1')
    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('muestra un toast de error cuando el retry falla', async () => {
    listMock.mockResolvedValueOnce([makeAbort()])
    retryMock.mockRejectedValueOnce(new Error('409 conflict'))

    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    await wrapper.find('.entry-actions button').trigger('click')
    await flushPromises()

    expect(retryMock).toHaveBeenCalledWith('abort-1')
    // El retry falló: no se recarga la lista, y queda un toast de error.
    expect(listMock).toHaveBeenCalledTimes(1)
    const toastStore = useToastStore()
    expect(
      toastStore.toasts.some((t) => t.variant === 'error' && t.message.includes('409 conflict')),
    ).toBe(true)
  })

  it('muestra un toast de error cuando falla la carga inicial', async () => {
    listMock.mockRejectedValueOnce(new Error('network down'))
    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('Sin runs abortados pendientes.')
    const toastStore = useToastStore()
    expect(
      toastStore.toasts.some((t) => t.variant === 'error' && t.message.includes('network down')),
    ).toBe(true)
  })
})
