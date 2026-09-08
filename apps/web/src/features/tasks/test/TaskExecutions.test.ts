import TaskExecutions from '@/features/tasks/TaskExecutions.vue'
import type { ExecutionLog } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchTaskExecutions = vi.fn()
vi.mock('@/features/tasks/api', () => ({
  fetchTaskExecutions: (...args: unknown[]) => fetchTaskExecutions(...(args as [])),
}))

function run(over: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'r1',
    projectId: 'ia-flow',
    taskId: 'I_1',
    taskTitle: 'Tools de filesystem',
    agentId: 'implementer',
    providerId: 'tmux-claude',
    startedAt: '2026-09-05T23:14:43.000Z',
    finishedAt: '2026-09-05T23:16:39.000Z',
    outcome: 'cancelled',
    errorMsg: null,
    stopReason: null,
    ...over,
  } as ExecutionLog
}

beforeEach(() => {
  fetchTaskExecutions.mockReset()
  fetchTaskExecutions.mockResolvedValue([run()])
})

async function mountWith(props: Record<string, unknown> = {}) {
  const wrapper = mount(TaskExecutions, {
    props: { projectId: 'ia-flow', taskId: 'I_1', ...props },
  })
  await flushPromises()
  return wrapper
}

describe('TaskExecutions', () => {
  it('pide los runs de esta tarea y los lista', async () => {
    const wrapper = await mountWith()
    expect(fetchTaskExecutions).toHaveBeenCalledWith('ia-flow', 'I_1', 10)
    const row = wrapper.get('.run-row')
    expect(row.text()).toContain('implementer')
    expect(row.text()).toContain('cancelled')
  })

  // Un run vivo no tiene outcome todavía: mostrarlo como "sin outcome" lo
  // haría parecer roto.
  it('un run sin terminar se muestra como corriendo', async () => {
    fetchTaskExecutions.mockResolvedValue([run({ finishedAt: null, outcome: null })])
    const wrapper = await mountWith()
    expect(wrapper.get('.run-outcome').text()).toBe('corriendo')
    expect(wrapper.find('.run-duration').exists()).toBe(false)
  })

  it('la duración no produce "1m 60s" en el borde del minuto', async () => {
    fetchTaskExecutions.mockResolvedValue([run({ durationMs: 119_600 })])
    const wrapper = await mountWith()
    expect(wrapper.get('.run-duration').text()).toBe('2m 0s')
  })

  it('muestra el motivo cuando el run dejó uno', async () => {
    fetchTaskExecutions.mockResolvedValue([run({ outcome: 'error', errorMsg: 'boom' })])
    const wrapper = await mountWith()
    expect(wrapper.get('.run-reason').text()).toBe('boom')
  })

  // `errorMsg` puede traer la respuesta cruda del modelo: un truncado por
  // pause_turn dejó una de 29 KB en la base.
  it('recorta un motivo enorme en vez de volcarlo entero', async () => {
    fetchTaskExecutions.mockResolvedValue([
      run({ outcome: 'truncated', errorMsg: 'x'.repeat(5000) }),
    ])
    const wrapper = await mountWith()
    expect(wrapper.get('.run-reason').text().length).toBeLessThan(200)
  })

  it('una acción de la regla se distingue de un run de agente', async () => {
    fetchTaskExecutions.mockResolvedValue([
      run({ kind: 'action', agentId: 'Notificar en macOS', providerId: '', outcome: 'success' }),
    ])
    const wrapper = await mountWith()
    expect(wrapper.get('.run-agent').classes()).toContain('is-action')
  })

  it('una tarea sin runs lo dice', async () => {
    fetchTaskExecutions.mockResolvedValue([])
    const wrapper = await mountWith()
    expect(wrapper.get('.empty').text()).toContain('todavía no corrió')
  })

  it('un fallo al cargar no rompe la sección', async () => {
    fetchTaskExecutions.mockRejectedValue(new Error('502'))
    const wrapper = await mountWith()
    expect(wrapper.get('.runs-error').text()).toContain('502')
  })

  // Después de un "Correr ahora" el listado se recarga solo: obligar a cerrar
  // y abrir el detalle para ver el run que acabás de lanzar es peor que una
  // llamada de más.
  it('el reloadToken vuelve a pedir la lista', async () => {
    const wrapper = await mountWith({ reloadToken: null })
    await wrapper.setProps({ reloadToken: { outcome: 'dispatched', status: 'build' } })
    await flushPromises()
    expect(fetchTaskExecutions).toHaveBeenCalledTimes(2)
  })

  it('cambiar de tarea vuelve a consultar por la nueva', async () => {
    const wrapper = await mountWith()
    await wrapper.setProps({ taskId: 'I_2' })
    await flushPromises()
    expect(fetchTaskExecutions).toHaveBeenLastCalledWith('ia-flow', 'I_2', 10)
  })
})
