import type { ExecutionLog } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Module mocks ─────────────────────────────────────────────────────────
// The component pulls on several axios wrappers and a WebSocket composable
// during `onMounted`. Stub them out so the test doesn't need a live backend
// or a real WS server.

const fetchExecutionsMock = vi.fn<[unknown], Promise<ExecutionLog[]>>()
vi.mock('./api', () => ({
  fetchExecutions: (filters: unknown) => fetchExecutionsMock(filters),
  fetchActiveExecutions: vi.fn(),
}))
vi.mock('@/features/projects/availableApi', () => ({
  fetchAvailableAgents: vi.fn().mockResolvedValue([]),
  fetchAvailableSystemPrompts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/features/projects/sourceApi', () => ({
  fetchProjectItems: vi.fn().mockResolvedValue({ kind: 'noop', items: [] }),
}))
vi.mock('@/features/server-logs/api', () => ({
  fetchServerLogs: vi.fn().mockResolvedValue({ entries: [] }),
}))
// Skip the WS lifecycle entirely — happy-dom doesn't ship a functional
// WebSocket and this component's live-mode isn't under test here.
vi.mock('@/composables/useServerEvents', () => ({
  useServerEvents: () => ({ connected: { value: false } }),
}))
// The pending-chip behaviour never navigates; a shallow router stub is
// enough to satisfy `useRouter()`.
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

import { useProjectsStore } from '@/features/projects/store'
import ExecutionsSection from './ExecutionsSection.vue'

function makeExec(overrides: Partial<ExecutionLog>): ExecutionLog {
  return {
    id: 'e-default',
    projectId: 'p-1',
    taskId: 't-default',
    taskTitle: 'Default task',
    agentId: 'agent',
    providerId: 'anthropic-api',
    startedAt: '2025-01-01T00:00:00Z',
    finishedAt: '2025-01-01T00:00:05Z',
    outcome: 'success',
    errorMsg: null,
    stopReason: null,
    ...overrides,
  }
}

async function mountWithExecs(execs: ExecutionLog[]) {
  fetchExecutionsMock.mockResolvedValueOnce(execs)
  const wrapper = mount(ExecutionsSection, { props: { scope: 'project' } })
  // Wait for onMounted → load() → executions.value = [...] → re-render.
  await flushPromises()
  return wrapper
}

describe('ExecutionsSection — pending summary chip', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Prime an active project so the component's load() path proceeds
    // instead of surfacing "Selecciona un proyecto primero".
    const store = useProjectsStore()
    store.activeProjectId = 'p-1'
    fetchExecutionsMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('filters the list to rows where outcome === null when clicked', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-succ', taskId: 't-succ', taskTitle: 'Done task', outcome: 'success' }),
      makeExec({
        id: 'e-pen',
        taskId: 't-pen',
        taskTitle: 'Running task',
        outcome: null,
        finishedAt: null,
      }),
      makeExec({ id: 'e-err', taskId: 't-err', taskTitle: 'Broken task', outcome: 'error' }),
    ])

    // Sanity: all 3 rows visible before the chip is engaged.
    expect(wrapper.findAll('.exec-card')).toHaveLength(3)

    const pendingChip = wrapper.get('[data-testid="executions-summary-pending"]')
    // Baseline: pending chip is not pressed.
    expect(pendingChip.attributes('aria-pressed')).toBe('false')

    await pendingChip.trigger('click')

    const rows = wrapper.findAll('.exec-card')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('Running task')
    expect(pendingChip.attributes('aria-pressed')).toBe('true')
  })

  it('toggles off on a second click and restores every execution', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e1', outcome: 'success' }),
      makeExec({ id: 'e2', outcome: null, finishedAt: null }),
      makeExec({ id: 'e3', outcome: 'cancelled' }),
    ])

    const pendingChip = wrapper.get('[data-testid="executions-summary-pending"]')

    await pendingChip.trigger('click')
    expect(wrapper.findAll('.exec-card')).toHaveLength(1)
    expect(pendingChip.attributes('aria-pressed')).toBe('true')

    await pendingChip.trigger('click')
    expect(wrapper.findAll('.exec-card')).toHaveLength(3)
    expect(pendingChip.attributes('aria-pressed')).toBe('false')
  })

  it('does not fire a server refetch when the pending chip is toggled', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e1', outcome: 'success' }),
      makeExec({ id: 'e2', outcome: null, finishedAt: null }),
    ])

    expect(fetchExecutionsMock).toHaveBeenCalledTimes(1)

    const pendingChip = wrapper.get('[data-testid="executions-summary-pending"]')
    await pendingChip.trigger('click')
    await flushPromises()

    // Pending is purely client-side — no extra network call.
    expect(fetchExecutionsMock).toHaveBeenCalledTimes(1)
  })

  it('other outcome chips (error) still trigger a server refetch with the outcome payload', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e1', outcome: 'success' }),
      makeExec({ id: 'e2', outcome: 'error' }),
    ])
    expect(fetchExecutionsMock).toHaveBeenCalledTimes(1)

    // The second call to fetchExecutions will resolve with the "filtered"
    // page — value doesn't matter for the assertion, just that it resolves.
    fetchExecutionsMock.mockResolvedValueOnce([makeExec({ id: 'e2', outcome: 'error' })])

    const errorChip = wrapper.get('[data-testid="executions-summary-error"]')
    await errorChip.trigger('click')
    await flushPromises()

    expect(fetchExecutionsMock).toHaveBeenCalledTimes(2)
    const secondCallArg = fetchExecutionsMock.mock.calls[1]?.[0] as { outcome?: string[] }
    expect(secondCallArg.outcome).toEqual(['error'])

    // The pending flag is left alone by clicks on other outcome chips.
    const pendingChip = wrapper.get('[data-testid="executions-summary-pending"]')
    expect(pendingChip.attributes('aria-pressed')).toBe('false')
    expect(errorChip.attributes('aria-pressed')).toBe('true')
  })
})
