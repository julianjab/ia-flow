import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentHostRunsCard from '../AgentHostRunsCard.vue'
import type { AgentHostRun } from '../api'

describe('AgentHostRunsCard', () => {
  it('mientras carga muestra el hint, no una lista vacía', () => {
    const wrapper = mount(AgentHostRunsCard, { props: { running: null, runs: null } })
    expect(wrapper.text()).toContain('cargando')
  })

  it('sin runs en vuelo lo dice explícitamente', () => {
    const wrapper = mount(AgentHostRunsCard, { props: { running: 0, runs: [] } })
    expect(wrapper.text()).toContain('sin runs en vuelo')
  })

  it('lista taskId/agentId/projectId/mode de cada run', () => {
    const runs: AgentHostRun[] = [
      {
        runId: 'r-1',
        taskId: 't-9',
        agentId: 'reviewer',
        projectId: 'p1',
        mode: 'detached',
        startedAt: '2026-09-11T00:00:00.000Z',
      },
      { taskId: 't-2', mode: 'inline', startedAt: '2026-09-11T00:00:01.000Z' },
    ]
    const wrapper = mount(AgentHostRunsCard, { props: { running: 2, runs } })

    expect(wrapper.text()).toContain('t-9')
    expect(wrapper.text()).toContain('reviewer')
    expect(wrapper.text()).toContain('p1')
    expect(wrapper.text()).toContain('detached')
    // El segundo run no trae agentId/projectId — se muestra el placeholder, no vacío.
    expect(wrapper.text()).toContain('t-2')
    expect(wrapper.findAll('.line__agent')[1]?.text()).toBe('—')
  })
})
