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
// `useRoute` is used by ExecutionsSection to read `?runId=` on mount and
// auto-open the drawer. The hoisted holder lets each test swap the query
// object before mounting without racing the module mock.
const routeHolder = vi.hoisted(() => ({
  current: { query: {} as Record<string, string | string[] | undefined> },
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => routeHolder.current,
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
    // Reset route between tests so the runId auto-expand in this suite
    // doesn't leak into the pending-chip assertions below.
    routeHolder.current = { query: {} }
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

describe('ExecutionsSection — auto-expand from ?runId=', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useProjectsStore()
    store.activeProjectId = 'p-1'
    fetchExecutionsMock.mockReset()
    routeHolder.current = { query: {} }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('auto-opens the drawer for the run matching route.query.runId once the list loads', async () => {
    // Simulate landing on `/projects/p-1/executions?runId=e-target` from
    // the dashboard: the component should open the drawer without any
    // extra click from the user.
    routeHolder.current = { query: { runId: 'e-target' } }

    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-other', taskTitle: 'Otro' }),
      makeExec({ id: 'e-target', taskTitle: 'Buscada' }),
    ])

    const drawer = wrapper.find('[data-testid="executions-detail-drawer"]')
    expect(drawer.exists()).toBe(true)
    // The drawer's body contains the taskId of the selected exec, so we
    // assert on that text to prove the *correct* run was expanded.
    expect(drawer.text()).toContain('Buscada')
    expect(drawer.text()).not.toContain('Otro')
  })

  it('does not error and leaves the drawer closed when runId is outside the loaded page', async () => {
    // Edge case documented in the PRD: run exists beyond the initial 100
    // results — the component must render normally instead of throwing.
    routeHolder.current = { query: { runId: 'e-missing' } }

    const wrapper = await mountWithExecs([
      makeExec({ id: 'e1' }),
      makeExec({ id: 'e2' }),
    ])

    expect(wrapper.find('[data-testid="executions-detail-drawer"]').exists()).toBe(false)
    // List still renders — proves the section didn't fail on the bogus id.
    expect(wrapper.findAll('.exec-card')).toHaveLength(2)
  })

  it('leaves the drawer closed when no runId is present in the URL', async () => {
    // Default entry (no query) must never auto-open a drawer.
    routeHolder.current = { query: {} }

    const wrapper = await mountWithExecs([makeExec({ id: 'e1' })])

    expect(wrapper.find('[data-testid="executions-detail-drawer"]').exists()).toBe(false)
  })

  it('runId does not leak into fetchExecutions server-side filters', async () => {
    // Guardrail: the runId is UI-only. It must not be forwarded as a
    // server filter (there is no `id` filter on ExecutionLogFiltersSchema)
    // and must not disturb the other filter fields.
    routeHolder.current = { query: { runId: 'e1' } }

    await mountWithExecs([makeExec({ id: 'e1' })])

    expect(fetchExecutionsMock).toHaveBeenCalledTimes(1)
    const firstArg = fetchExecutionsMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(firstArg).not.toHaveProperty('id')
    expect(firstArg).not.toHaveProperty('runId')
    expect(firstArg.projectId).toBe('p-1')
  })
})
