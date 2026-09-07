import RunningRunsPanel from '@/features/executions/RunningRunsPanel.vue'
import { useActiveExecutionsStore } from '@/features/executions/activeStore'
import type { ExecutionLog } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/executions/api', () => ({
  fetchActiveExecutions: vi.fn(async () => []),
}))

function run(over: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'r1',
    projectId: 'p1',
    taskId: 'I_1',
    taskTitle: 'Endpoint de leads por teléfono',
    agentId: 'implementer',
    providerId: 'anthropic-api',
    startedAt: new Date(Date.now() - 125_000).toISOString(),
    finishedAt: null,
    outcome: null,
    errorMsg: null,
    stopReason: null,
    ...over,
  } as ExecutionLog
}

beforeEach(() => {
  setActivePinia(createPinia())
})

function mountWith(runs: ExecutionLog[], projectId: string | null = 'p1') {
  const store = useActiveExecutionsStore()
  store.executions = runs
  return mount(RunningRunsPanel, { props: { projectId } })
}

describe('RunningRunsPanel', () => {
  it('lista los runs en vuelo con su duración corriendo', async () => {
    const wrapper = mountWith([run()])
    expect(wrapper.get('.rr-title').text()).toContain('Endpoint de leads')
    // 125s desde que arrancó: la duración se calcula contra el ahora, no se
    // congela en el valor que traía la fila.
    expect(wrapper.get('.rr-elapsed').text()).toBe('2m 05s')
  })

  // El server no guarda pasos dentro de un run: una barra de progreso o un
  // `3/5` serían inventados.
  it('no dibuja barra de pasos ni N/M', async () => {
    const wrapper = mountWith([run()])
    expect(wrapper.text()).not.toMatch(/\d\/\d/)
    expect(wrapper.find('.rr-steps').exists()).toBe(false)
  })

  it('sin nada corriendo no ocupa espacio', () => {
    expect(mountWith([]).find('.rr').exists()).toBe(false)
  })

  it('en una vista de proyecto sólo muestra los suyos', () => {
    const wrapper = mountWith([run(), run({ id: 'r2', projectId: 'otro' })])
    expect(wrapper.findAll('.rr-card')).toHaveLength(1)
  })

  it('en la vista global los muestra todos', () => {
    const wrapper = mountWith([run(), run({ id: 'r2', projectId: 'otro' })], null)
    expect(wrapper.findAll('.rr-card')).toHaveLength(2)
  })

  it('emite open y cancel con el run', async () => {
    const wrapper = mountWith([run()])
    await wrapper.get('.btn--ghost').trigger('click')
    await wrapper.get('.btn--danger').trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual(['r1'])
    expect((wrapper.emitted('cancel')?.[0] as ExecutionLog[])[0].id).toBe('r1')
  })
})
