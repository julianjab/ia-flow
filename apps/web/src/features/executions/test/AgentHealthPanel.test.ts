import type { ExecutionStats } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchExecutionStatsMock = vi.fn<[unknown], Promise<ExecutionStats>>()
const fetchAgentDetailMock = vi.fn()
vi.mock('../api', () => ({
  fetchExecutionStats: (filters: unknown) => fetchExecutionStatsMock(filters),
  fetchAgentDetail: (agentId: string, filters: unknown) => fetchAgentDetailMock(agentId, filters),
}))

import AgentHealthPanel from '../AgentHealthPanel.vue'

function stats(overrides: Partial<ExecutionStats> = {}): ExecutionStats {
  return {
    from: null,
    to: null,
    totals: {
      runs: 0,
      success: 0,
      error: 0,
      cancelled: 0,
      truncated: 0,
      successRate: null,
      failureClasses: {},
      tokensIn: 0,
      tokensOut: 0,
    },
    agents: [],
    ...overrides,
  }
}

function agent(overrides: Partial<ExecutionStats['agents'][number]> = {}) {
  return {
    agentId: 'implementer',
    runs: 10,
    success: 9,
    error: 1,
    cancelled: 0,
    truncated: 0,
    successRate: 0.9,
    failureClasses: {},
    avgDurationMs: 1500,
    tokensIn: 1000,
    tokensOut: 200,
    toolCalls: 40,
    toolErrors: 0,
    lastRunAt: '2026-01-01T00:00:00.000Z',
    promptVersions: 1,
    ...overrides,
  }
}

describe('AgentHealthPanel', () => {
  beforeEach(() => {
    fetchExecutionStatsMock.mockReset()
    fetchExecutionStatsMock.mockResolvedValue(stats())
    fetchAgentDetailMock.mockReset()
    fetchAgentDetailMock.mockResolvedValue(null)
  })

  it('requests a 7-day window scoped to the project by default', async () => {
    mount(AgentHealthPanel, { props: { projectId: 'proj-1' } })
    await flushPromises()

    const filters = fetchExecutionStatsMock.mock.calls[0]![0] as { from: string; projectId: string }
    expect(filters.projectId).toBe('proj-1')
    const days = (Date.now() - Date.parse(filters.from)) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
  })

  it('omits projectId when scoped globally', async () => {
    mount(AgentHealthPanel, { props: { projectId: null } })
    await flushPromises()
    expect(fetchExecutionStatsMock.mock.calls[0]![0]).not.toHaveProperty('projectId')
  })

  it('refetches when the window changes', async () => {
    const wrapper = mount(AgentHealthPanel, { props: { projectId: null } })
    await flushPromises()
    await wrapper.findAll('.window-chip')[2]!.trigger('click')
    await flushPromises()

    const filters = fetchExecutionStatsMock.mock.calls[1]![0] as { from: string }
    const days = (Date.now() - Date.parse(filters.from)) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(29.9)
  })

  it('shows an em dash instead of 0% when an agent has no finished runs', async () => {
    fetchExecutionStatsMock.mockResolvedValue(
      stats({ agents: [agent({ runs: 0, success: 0, successRate: null })] }),
    )
    const wrapper = mount(AgentHealthPanel, { props: { projectId: null } })
    await flushPromises()

    const badge = wrapper.find('.health-badge')
    expect(badge.text()).toBe('—')
    expect(badge.classes()).toContain('health--unknown')
  })

  it('does not colour a healthy-looking agent green on a tiny sample', async () => {
    fetchExecutionStatsMock.mockResolvedValue(
      stats({ agents: [agent({ runs: 2, success: 2, successRate: 1 })] }),
    )
    const wrapper = mount(AgentHealthPanel, { props: { projectId: null } })
    await flushPromises()
    expect(wrapper.find('.health-badge').classes()).toContain('health--unknown')
  })

  it('flags an agent whose prompt changed mid-window', async () => {
    fetchExecutionStatsMock.mockResolvedValue(stats({ agents: [agent({ promptVersions: 3 })] }))
    const wrapper = mount(AgentHealthPanel, { props: { projectId: null } })
    await flushPromises()
    expect(wrapper.find('.prompt-warn').text()).toContain('3 prompts')
  })

  it('emits a drill event with the agent and class behind a chip', async () => {
    fetchExecutionStatsMock.mockResolvedValue(
      stats({
        agents: [agent({ failureClasses: { tool_failure: 4, budget_exhausted: 1 } })],
      }),
    )
    const wrapper = mount(AgentHealthPanel, { props: { projectId: null } })
    await flushPromises()

    const chips = wrapper.findAll('.class-chip')
    // Sorted by count, so the most frequent class reads first.
    expect(chips[0]!.text()).toContain('tools fallando · 4')
    await chips[0]!.trigger('click')

    expect(wrapper.emitted('drill')![0]).toEqual([
      { agentId: 'implementer', failureClass: 'tool_failure' },
    ])
  })

  it('surfaces a fetch failure instead of rendering an empty table', async () => {
    fetchExecutionStatsMock.mockRejectedValue(new Error('boom'))
    const wrapper = mount(AgentHealthPanel, { props: { projectId: null } })
    await flushPromises()
    expect(wrapper.find('.health-error').exists()).toBe(true)
    expect(wrapper.find('.health-table').exists()).toBe(false)
  })

  it('expands one agent at a time and asks for its detail', async () => {
    fetchExecutionStatsMock.mockResolvedValue(
      stats({ agents: [agent(), agent({ agentId: 'reviewer' })] }),
    )
    const wrapper = mount(AgentHealthPanel, { props: { projectId: 'proj-1' } })
    await flushPromises()

    await wrapper.findAll('.agent-row')[0]!.trigger('click')
    await flushPromises()
    expect(fetchAgentDetailMock).toHaveBeenCalledWith('implementer', expect.anything())
    expect(wrapper.findAll('.detail-row')).toHaveLength(1)

    // Opening a second one replaces the first rather than stacking.
    await wrapper.findAll('.agent-row')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.detail-row')).toHaveLength(1)
    expect(fetchAgentDetailMock).toHaveBeenLastCalledWith('reviewer', expect.anything())
  })

  it('collapses an agent when its row is clicked again', async () => {
    fetchExecutionStatsMock.mockResolvedValue(stats({ agents: [agent()] }))
    const wrapper = mount(AgentHealthPanel, { props: { projectId: null } })
    await flushPromises()

    await wrapper.find('.agent-row').trigger('click')
    await flushPromises()
    await wrapper.find('.agent-row').trigger('click')
    expect(wrapper.findAll('.detail-row')).toHaveLength(0)
  })

  it('does not expand a row when a failure chip inside it is clicked', async () => {
    fetchExecutionStatsMock.mockResolvedValue(
      stats({ agents: [agent({ failureClasses: { tool_failure: 4 } })] }),
    )
    const wrapper = mount(AgentHealthPanel, { props: { projectId: null } })
    await flushPromises()

    await wrapper.find('.class-chip').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('drill')).toBeTruthy()
    expect(wrapper.findAll('.detail-row')).toHaveLength(0)
  })
})
