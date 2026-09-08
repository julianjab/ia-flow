import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/stores/toast'
import type { AgentAbortRecord, RecoverableCheckpoint, RecoverableRuns } from '../agent-aborts-api'

const listMock = vi.fn<[], Promise<RecoverableRuns>>()
const retryAbortMock = vi.fn()
const retryCheckpointMock = vi.fn()
vi.mock('../agent-aborts-api', () => ({
  listRecoverableRuns: () => listMock(),
  retryAgentAbort: (id: string) => retryAbortMock(id),
  retryRecoverableCheckpoint: (taskId: string, projectId: string) =>
    retryCheckpointMock(taskId, projectId),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
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

function makeCheckpoint(overrides: Partial<RecoverableCheckpoint> = {}): RecoverableCheckpoint {
  return {
    runId: 'cp-run-1',
    taskId: 'task-99',
    taskTitle: 'Solucionar este error',
    projectId: 'proj-1',
    agentId: 'refiner',
    updatedAt: new Date().toISOString(),
    attempts: 0,
    resumable: true,
    stillOpen: true,
    ...overrides,
  }
}

function runs(overrides: Partial<RecoverableRuns> = {}): RecoverableRuns {
  return { aborts: [], checkpoints: [], ...overrides }
}

beforeEach(() => {
  setActivePinia(createPinia())
  listMock.mockReset()
  retryAbortMock.mockReset()
  retryCheckpointMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentAbortsSection', () => {
  it('carga y muestra los aborts al montar', async () => {
    listMock.mockResolvedValueOnce(runs({ aborts: [makeAbort()] }))
    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('task-42')
    expect(wrapper.text()).toContain('builder')
    expect(wrapper.text()).toContain('reintentando')
    expect(wrapper.text()).toContain('1/5 intentos')
    expect(wrapper.text()).toContain('upstream stalled after 60s without data')
  })

  it('muestra el estado vacío cuando no hay nada recuperable', async () => {
    listMock.mockResolvedValueOnce(runs())
    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('Sin runs recuperables pendientes.')
  })

  it('marca exhausted con su propio badge', async () => {
    listMock.mockResolvedValueOnce(runs({ aborts: [makeAbort({ status: 'exhausted' })] }))
    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('agotado')
    expect(wrapper.find('.status-exhausted').exists()).toBe(true)
  })

  it('reintenta y recarga la lista al hacer click en Reintentar', async () => {
    listMock.mockResolvedValueOnce(runs({ aborts: [makeAbort()] }))
    retryAbortMock.mockResolvedValueOnce(undefined)
    listMock.mockResolvedValueOnce(runs())

    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    await wrapper.find('.entry-actions button').trigger('click')
    await flushPromises()

    expect(retryAbortMock).toHaveBeenCalledWith('abort-1')
    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('muestra un toast de error cuando el retry de un abort falla', async () => {
    listMock.mockResolvedValueOnce(runs({ aborts: [makeAbort()] }))
    retryAbortMock.mockRejectedValueOnce(new Error('409 conflict'))

    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    await wrapper.find('.entry-actions button').trigger('click')
    await flushPromises()

    expect(retryAbortMock).toHaveBeenCalledWith('abort-1')
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

    expect(wrapper.text()).toContain('Sin runs recuperables pendientes.')
    const toastStore = useToastStore()
    expect(
      toastStore.toasts.some((t) => t.variant === 'error' && t.message.includes('network down')),
    ).toBe(true)
  })

  it('muestra los checkpoints recuperables con su propio grupo', async () => {
    listMock.mockResolvedValueOnce(runs({ checkpoints: [makeCheckpoint()] }))
    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('Checkpoints recuperables')
    expect(wrapper.text()).toContain('Solucionar este error')
    expect(wrapper.text()).toContain('refiner')
    expect(wrapper.text()).toContain('resumible')
    expect(wrapper.text()).toContain('Quedó en vuelo, esperando el próximo dispatch')
  })

  it('un checkpoint que ya no pasa los gates se marca no resumible, con el motivo', async () => {
    listMock.mockResolvedValueOnce(runs({ checkpoints: [makeCheckpoint({ resumable: false })] }))
    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    expect(wrapper.text()).toContain('no resumible')
    expect(wrapper.text()).toContain('el próximo dispatch va a arrancar de')
  })

  it('reintentar un checkpoint re-emite el status de la tarea y recarga', async () => {
    listMock.mockResolvedValueOnce(runs({ checkpoints: [makeCheckpoint()] }))
    retryCheckpointMock.mockResolvedValueOnce(undefined)
    listMock.mockResolvedValueOnce(runs())

    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    await wrapper.find('.entry-actions button').trigger('click')
    await flushPromises()

    expect(retryCheckpointMock).toHaveBeenCalledWith('task-99', 'proj-1')
    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('sin projectId el botón de reintentar un checkpoint queda deshabilitado', async () => {
    listMock.mockResolvedValueOnce(runs({ checkpoints: [makeCheckpoint({ projectId: null })] }))
    const wrapper = mount(AgentAbortsSection)
    await flushPromises()

    const button = wrapper.find('.entry-actions button')
    expect(button.attributes('disabled')).toBeDefined()
  })
})
