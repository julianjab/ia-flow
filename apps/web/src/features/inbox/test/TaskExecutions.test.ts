import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detail, execution, item, trace } from '@/features/inbox/test/fixtures'

const getTaskDetail = vi.fn()
vi.mock('@/features/inbox/api', () => ({
  getTaskDetail: (...args: unknown[]) => getTaskDetail(...args),
}))

import TaskDetailPanel from '@/features/inbox/TaskDetailPanel.vue'
import TaskExecutions from '@/features/inbox/TaskExecutions.vue'

const failed = (id: string, started_at: string) =>
  execution({
    id,
    pipeline_id: 'refine',
    agent_id: 'refiner',
    status: 'failed',
    started_at,
    closed_at: started_at.replace(':00.000Z', ':41.000Z'),
    failure: { by: 'runtime', message: 'Anthropic API → 400: tool_use sin tool_result' },
  })

const row = (w: ReturnType<typeof mount>, id: string) => w.get(`[data-test="execution-${id}"]`)

describe('TaskExecutions', () => {
  beforeEach(() => {
    getTaskDetail.mockReset()
  })

  it('arranca abierta la que corre, con la traza en vivo; las demás plegadas', async () => {
    const w = mount(TaskExecutions, {
      props: {
        taskRef: 'o/r#1',
        executions: [
          execution({ id: 'ex1', status: 'running' }),
          failed('ex0', '2026-01-01T09:00:00.000Z'),
        ],
        liveTrace: [trace({ execution_id: 'ex1', name: 'fs_read app/ability.rb' })],
      },
    })
    await flushPromises()

    expect(row(w, 'ex1').attributes('aria-expanded')).toBe('true')
    expect(row(w, 'ex1').text()).toContain('en curso')
    expect(w.text()).toContain('fs_read app/ability.rb')
    expect(row(w, 'ex0').attributes('aria-expanded')).toBe('false')
    // Plegada, la fila dice quién la cortó; el error crudo no (va una vez, en «Detalle técnico»).
    expect(row(w, 'ex0').text()).toContain('falló el runner')
    expect(row(w, 'ex0').text()).not.toContain('400: tool_use sin tool_result')
    expect(getTaskDetail).not.toHaveBeenCalled()
  })

  it('sin una en curso, abre la última que falló y pide su traza', async () => {
    getTaskDetail.mockResolvedValue(
      detail(item(), { trace: [trace({ execution_id: 'ex2', name: 'chat claude · round 1' })] }),
    )
    const w = mount(TaskExecutions, {
      props: {
        taskRef: 'o/r#1',
        executions: [
          execution({ id: 'ex3', status: 'done', exit: 'done' }),
          failed('ex2', '2026-01-01T09:30:00.000Z'),
        ],
        liveTrace: [trace({ execution_id: 'ex3' })],
      },
    })
    await flushPromises()

    expect(row(w, 'ex3').attributes('aria-expanded')).toBe('false')
    expect(row(w, 'ex2').attributes('aria-expanded')).toBe('true')
    expect(getTaskDetail).toHaveBeenCalledWith('o/r#1', 'ex2')
    expect(w.text()).toContain('chat claude · round 1')
    // El error crudo, UNA vez: plegado en «Detalle técnico» de la abierta.
    expect(w.get('[data-test="tech"]').text()).toContain('400: tool_use sin tool_result')
    expect(w.text().split('400: tool_use sin tool_result')).toHaveLength(2)
  })

  it('una plegada pide su traza al abrirla, una sola vez', async () => {
    getTaskDetail.mockResolvedValue(detail(item(), { trace: [trace({ name: 'pipeline build' })] }))
    const w = mount(TaskExecutions, {
      props: {
        taskRef: 'o/r#1',
        executions: [
          execution({ id: 'ex2', status: 'done' }),
          execution({ id: 'ex1', status: 'done' }),
        ],
        liveTrace: [],
      },
    })
    await flushPromises()
    expect(getTaskDetail).not.toHaveBeenCalled()

    await row(w, 'ex1').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('pipeline build')
    await row(w, 'ex1').trigger('click')
    await row(w, 'ex1').trigger('click')
    await flushPromises()
    expect(getTaskDetail).toHaveBeenCalledTimes(1)
  })

  it('si la traza no llega, lo dice y deja reintentar', async () => {
    getTaskDetail.mockRejectedValueOnce(new Error('El runner respondió 502'))
    getTaskDetail.mockResolvedValueOnce(detail(item(), { trace: [trace({ name: 'ya está' })] }))
    const w = mount(TaskExecutions, {
      props: {
        taskRef: 'o/r#1',
        executions: [failed('ex1', '2026-01-01T09:00:00.000Z')],
        liveTrace: [],
      },
    })
    await flushPromises()
    // `ex1` es la última: su traza es la del detalle (vacía), así que la segunda falla es la de una vieja.
    expect(getTaskDetail).not.toHaveBeenCalled()

    await w.setProps({
      executions: [
        execution({ id: 'ex9', status: 'done' }),
        failed('ex1', '2026-01-01T09:00:00.000Z'),
      ],
      liveTrace: [trace({ execution_id: 'ex9' })],
    })
    // Ya abierta, pero ahora no es la del detalle: se reabre para pedirla.
    await row(w, 'ex1').trigger('click')
    await row(w, 'ex1').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('El runner respondió 502')
    await w.get('[data-test="action-error"] .btn').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('ya está')
  })

  it('un evento que pide una ejecución la abre', async () => {
    getTaskDetail.mockResolvedValue(detail(item(), { trace: [trace({ name: 'vieja' })] }))
    const w = mount(TaskExecutions, {
      props: {
        taskRef: 'o/r#1',
        executions: [
          execution({ id: 'ex2', status: 'done' }),
          execution({ id: 'ex1', status: 'done' }),
        ],
        liveTrace: [],
        focus: null,
      },
    })
    await w.setProps({ focus: { id: 'ex1', at: 1 } })
    await flushPromises()

    expect(row(w, 'ex1').attributes('aria-expanded')).toBe('true')
    expect(w.get('[data-flash]').attributes('data-status')).toBe('done')
    expect(w.text()).toContain('vieja')
  })

  it('una que arranca con el panel abierto se abre sola', async () => {
    const w = mount(TaskExecutions, {
      props: {
        taskRef: 'o/r#1',
        executions: [execution({ id: 'ex1', status: 'done' })],
        liveTrace: [],
      },
    })
    await w.setProps({
      executions: [
        execution({ id: 'ex2', status: 'running' }),
        execution({ id: 'ex1', status: 'done' }),
      ],
    })
    expect(row(w, 'ex2').attributes('aria-expanded')).toBe('true')
  })

  it('sin ejecuciones no dibuja nada', () => {
    const w = mount(TaskExecutions, { props: { taskRef: 'o/r#1', executions: [], liveTrace: [] } })
    expect(w.find('section').exists()).toBe(false)
  })
})

describe('TaskDetailPanel', () => {
  it('si lo que dijo el agente es el error crudo, el error sale una sola vez (en «Detalle técnico»)', async () => {
    const message = 'Anthropic API → 400: tool_use sin tool_result'
    const ex = failed('ex0', '2026-01-01T09:00:00.000Z')
    const it = item({ agent_said: message, execution: ex })
    getTaskDetail.mockResolvedValue(detail(it, { executions: [ex] }))
    const w = mount(TaskDetailPanel, {
      props: {
        item: it,
        detail: { loading: false, error: null, data: detail(it, { executions: [ex] }) },
      },
      global: { plugins: [createPinia()] },
    })
    await flushPromises()
    expect(w.find('.td__quote').exists()).toBe(false)
    expect(w.text().split(message).length - 1).toBe(1)
  })

  it('lo que dijo el agente, si no es el error, se cita con ✦', async () => {
    const ex = failed('ex0', '2026-01-01T09:00:00.000Z')
    const it = item({ agent_said: 'No encontré el endpoint de pagos.', execution: ex })
    getTaskDetail.mockResolvedValue(detail(it, { executions: [ex] }))
    const w = mount(TaskDetailPanel, {
      props: {
        item: it,
        detail: { loading: false, error: null, data: detail(it, { executions: [ex] }) },
      },
      global: { plugins: [createPinia()] },
    })
    await flushPromises()
    expect(w.get('.td__quote').text()).toContain('✦')
    expect(w.get('.td__quote').text()).toContain('No encontré el endpoint de pagos.')
  })
})
