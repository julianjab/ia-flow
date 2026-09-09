import type { ExecutionLog } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TaskPipelineSteps from '@/components/TaskPipelineSteps.vue'

function run(over: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'r1',
    projectId: 'ia-flow',
    taskId: 'I_1',
    taskTitle: 'x',
    agentId: 'implementer',
    providerId: 'tmux-claude',
    startedAt: '2026-09-05T23:14:43.000Z',
    finishedAt: '2026-09-05T23:16:39.000Z',
    outcome: 'success',
    errorMsg: null,
    stopReason: null,
    initialStatus: null,
    ...over,
  } as ExecutionLog
}

describe('TaskPipelineSteps', () => {
  it('sin statuses no dibuja nada', () => {
    const wrapper = mount(TaskPipelineSteps, { props: { statuses: [], executions: [] } })
    expect(wrapper.find('.pipe-steps').exists()).toBe(false)
  })

  // Un status antes del actual en el pipeline no implica que la tarea haya
  // pasado por ahí — una regla puede saltarlo entero. Sin una ejecución que
  // lo evidencie, queda pendiente aunque esté "atrás".
  it('un status anterior sin ejecución queda pendiente, no "hecho"', () => {
    const wrapper = mount(TaskPipelineSteps, {
      props: { statuses: ['refine', 'build', 'review'], currentStatus: 'build', executions: [] },
    })
    const dots = wrapper.findAll('.pipe-dot')
    expect(dots[0]?.classes()).toContain('is-pending')
    expect(dots[1]?.classes()).toContain('is-current')
    expect(dots[2]?.classes()).toContain('is-pending')
  })

  it('el status actual se compara sin distinguir mayúsculas', () => {
    const wrapper = mount(TaskPipelineSteps, {
      props: { statuses: ['Refine', 'Build'], currentStatus: 'build', executions: [] },
    })
    const dots = wrapper.findAll('.pipe-dot')
    expect(dots[1]?.classes()).toContain('is-current')
  })

  it('una ejecución con outcome pinta su paso, aunque ya haya avanzado el pipeline', () => {
    const wrapper = mount(TaskPipelineSteps, {
      props: {
        statuses: ['refine', 'build'],
        currentStatus: 'build',
        executions: [run({ initialStatus: 'refine', outcome: 'error' })],
      },
    })
    const dots = wrapper.findAll('.pipe-dot')
    expect(dots[0]?.classes()).toContain('is-error')
  })

  it('un run vivo se marca como corriendo, no como su outcome final', () => {
    const wrapper = mount(TaskPipelineSteps, {
      props: {
        statuses: ['build'],
        currentStatus: 'build',
        executions: [run({ initialStatus: 'build', finishedAt: null, outcome: null })],
      },
    })
    expect(wrapper.get('.pipe-dot').classes()).toContain('is-running')
  })

  it('sin status actual reconocible, todo queda pendiente salvo lo que marquen las ejecuciones', () => {
    const wrapper = mount(TaskPipelineSteps, {
      props: { statuses: ['refine', 'build'], currentStatus: 'cancelled', executions: [] },
    })
    const dots = wrapper.findAll('.pipe-dot')
    expect(dots[0]?.classes()).toContain('is-pending')
    expect(dots[1]?.classes()).toContain('is-pending')
  })
})
