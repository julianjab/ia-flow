import type { ExecutionLog } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Module mocks ─────────────────────────────────────────────────────────
// The component pulls on several axios wrappers and a WebSocket composable
// during `onMounted`. Stub them out so the test doesn't need a live backend
// or a real WS server.

const fetchExecutionsMock = vi.fn<[unknown], Promise<ExecutionLog[]>>()
const cancelExecutionMock = vi.fn()
vi.mock('../api', () => ({
  fetchExecutions: (filters: unknown) => fetchExecutionsMock(filters),
  fetchActiveExecutions: vi.fn(),
  cancelExecution: (id: string) => cancelExecutionMock(id),
  fetchExecutionSources: vi.fn().mockResolvedValue([]),
  // Pulled in by the embedded AgentHealthPanel on mount.
  fetchExecutionStats: vi.fn().mockResolvedValue({
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
  }),
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
// `useRoute` needs to be mutable between tests to exercise the ?runId
// auto-expand branch. Keep the query object as a module-level ref that each
// test can overwrite before mounting; the mock reads its current value on
// every call, so setting it in `beforeEach` is enough.
let currentRouteQuery: Record<string, unknown> = {}
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ query: currentRouteQuery }),
}))

import { useProjectsStore } from '@/features/projects/store'
import { useToastStore } from '@/stores/toast'
import ExecutionsSection from '../ExecutionsSection.vue'

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
  // The onMounted hook is async and reads `route.query.runId` *after* the
  // await, so we also need to flush the second microtask tick — a single
  // flushPromises() covers both because vue-test-utils waits for all pending.
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
    currentRouteQuery = {}
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

// ───────────────────────────────────────────────────────────────────────────
// `?runId=<id>` auto-expand — the dashboard's execution rows navigate to
// `/projects/<pid>/executions?runId=<id>`; this section is expected to open
// that run's drawer as soon as the initial page load resolves, so the
// operator lands on the same context they clicked.
// ───────────────────────────────────────────────────────────────────────────
describe('ExecutionsSection — ?runId auto-expand', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useProjectsStore()
    store.activeProjectId = 'p-1'
    fetchExecutionsMock.mockReset()
    currentRouteQuery = {}
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('opens the drawer for the matching run when ?runId is on the loaded page', async () => {
    currentRouteQuery = { runId: 'e-target' }
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-other', taskTitle: 'Other run' }),
      makeExec({ id: 'e-target', taskTitle: 'Deep-linked run' }),
    ])

    // Drawer is present (it renders `data-testid="executions-detail-drawer"`
    // only when `selectedExec` resolves) — proves toggleRow fired for the id.
    const drawer = wrapper.find('[data-testid="executions-detail-drawer"]')
    expect(drawer.exists()).toBe(true)
    expect(drawer.text()).toContain('Deep-linked run')

    // The matching card should reflect the open state.
    const openCards = wrapper.findAll('.exec-card--open')
    expect(openCards).toHaveLength(1)
    expect(openCards[0].text()).toContain('Deep-linked run')
  })

  it('renders normally when ?runId does not match any row in the loaded page', async () => {
    // Edge case documented in the PRD: exec is beyond the first 100 or was
    // deleted. The section must load without error and leave the drawer
    // closed rather than throwing.
    currentRouteQuery = { runId: 'e-not-in-page' }
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-a', taskTitle: 'A' }),
      makeExec({ id: 'e-b', taskTitle: 'B' }),
    ])

    expect(wrapper.find('[data-testid="executions-detail-drawer"]').exists()).toBe(false)
    expect(wrapper.findAll('.exec-card--open')).toHaveLength(0)
    // No error banner rendered.
    expect(wrapper.find('.items-error').exists()).toBe(false)
    // The list itself still renders both rows — the query is inert.
    expect(wrapper.findAll('.exec-card')).toHaveLength(2)
  })

  it('does not open any drawer when ?runId is absent', async () => {
    // Regression guard: the auto-expand branch should only fire when the
    // URL actually carries a `runId`. Without it the drawer stays closed.
    currentRouteQuery = {}
    const wrapper = await mountWithExecs([makeExec({ id: 'e-a', taskTitle: 'A' })])

    expect(wrapper.find('[data-testid="executions-detail-drawer"]').exists()).toBe(false)
    expect(wrapper.findAll('.exec-card--open')).toHaveLength(0)
  })

  it('does not interfere with server-side filters when ?runId is present', async () => {
    // Sanity: only the initial page-load fetch happens on mount — the
    // auto-expand path is pure UI. Clicking the error chip afterwards still
    // triggers a refetch with the outcome payload, unaffected by the runId.
    currentRouteQuery = { runId: 'e-target' }
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-target', outcome: 'success' }),
      makeExec({ id: 'e-other', outcome: 'error' }),
    ])

    expect(fetchExecutionsMock).toHaveBeenCalledTimes(1)
    const firstCallArg = fetchExecutionsMock.mock.calls[0]?.[0] as Record<string, unknown>
    // The initial load payload has no `runId` field — the filter set is
    // exactly what the existing schema supports.
    expect(firstCallArg).not.toHaveProperty('runId')

    fetchExecutionsMock.mockResolvedValueOnce([makeExec({ id: 'e-other', outcome: 'error' })])
    await wrapper.get('[data-testid="executions-summary-error"]').trigger('click')
    await flushPromises()

    expect(fetchExecutionsMock).toHaveBeenCalledTimes(2)
    const secondCallArg = fetchExecutionsMock.mock.calls[1]?.[0] as Record<string, unknown>
    expect(secondCallArg.outcome).toEqual(['error'])
    expect(secondCallArg).not.toHaveProperty('runId')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// "Detener" button — cancel flow for in-flight executions. Covers the PRD
// criteria: button only on rows with finishedAt === null, confirm-before-call
// via ui/ConfirmDialog.vue, row updates from the response without a refetch,
// and the 409 (forwarded) / alreadyFinished response branches.
// ───────────────────────────────────────────────────────────────────────────
describe('ExecutionsSection — cancel execution', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useProjectsStore()
    store.activeProjectId = 'p-1'
    fetchExecutionsMock.mockReset()
    cancelExecutionMock.mockReset()
    currentRouteQuery = {}
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('shows the "Detener" button only on rows still running (finishedAt === null)', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-running', outcome: null, finishedAt: null }),
      makeExec({ id: 'e-done', outcome: 'success' }),
    ])

    expect(wrapper.find('[data-testid="executions-stop-e-running"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="executions-stop-e-done"]').exists()).toBe(false)
  })

  it('asks for confirmation before calling cancelExecution, and does not call it on cancel', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-running', outcome: null, finishedAt: null }),
    ])

    await wrapper.get('[data-testid="executions-stop-e-running"]').trigger('click')
    // ConfirmDialog is rendered (not mocked) — its cancel button aborts.
    const cancelBtn = wrapper.get('.btn-cancel')
    await cancelBtn.trigger('click')
    await flushPromises()

    expect(cancelExecutionMock).not.toHaveBeenCalled()
  })

  it('calls cancelExecution and updates the row in place after confirming', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-running', taskTitle: 'Running task', outcome: null, finishedAt: null }),
    ])

    cancelExecutionMock.mockResolvedValueOnce({
      ok: true,
      execution: makeExec({
        id: 'e-running',
        taskTitle: 'Running task',
        outcome: 'cancelled',
        finishedAt: '2025-01-01T00:10:00Z',
      }),
    })

    await wrapper.get('[data-testid="executions-stop-e-running"]').trigger('click')
    await wrapper.get('.btn-confirm').trigger('click')
    await flushPromises()

    expect(cancelExecutionMock).toHaveBeenCalledWith('e-running')
    // No server refetch — the row updates from the response in local state.
    expect(fetchExecutionsMock).toHaveBeenCalledTimes(1)
    // The stop button disappears now that finishedAt is set.
    expect(wrapper.find('[data-testid="executions-stop-e-running"]').exists()).toBe(false)
    expect(wrapper.get('.exec-outcome').text()).toContain('cancelled')

    const toastStore = useToastStore()
    expect(toastStore.toasts.some((t) => t.variant === 'success')).toBe(true)
  })

  it('marks cancelRequestedAt (advisory only) when the execution is owned by another daemon', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-running', outcome: null, finishedAt: null, source: 'other-daemon' }),
    ])

    cancelExecutionMock.mockResolvedValueOnce({
      ok: true,
      cancelRequested: true,
      execution: makeExec({
        id: 'e-running',
        outcome: null,
        finishedAt: null,
        source: 'other-daemon',
        cancelRequestedAt: '2025-01-01T00:05:00Z',
      }),
    })

    await wrapper.get('[data-testid="executions-stop-e-running"]').trigger('click')
    await wrapper.get('.btn-confirm').trigger('click')
    await flushPromises()

    const toastStore = useToastStore()
    const successToast = toastStore.toasts.find((t) => t.variant === 'success')
    expect(successToast?.message).toContain('other-daemon')
    // Still running (not actually stopped) — the stop button stays, and the
    // row now shows an advisory "cancelación solicitada" badge.
    expect(wrapper.find('[data-testid="executions-stop-e-running"]').exists()).toBe(true)
    expect(wrapper.find('.exec-cancel-requested').exists()).toBe(true)
    expect(wrapper.findAll('.exec-card')).toHaveLength(1)
  })

  it('does not show an error toast when the response reports alreadyFinished', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-running', outcome: null, finishedAt: null }),
    ])

    cancelExecutionMock.mockResolvedValueOnce({
      ok: true,
      alreadyFinished: true,
      execution: makeExec({ id: 'e-running', outcome: 'success' }),
    })

    await wrapper.get('[data-testid="executions-stop-e-running"]').trigger('click')
    await wrapper.get('.btn-confirm').trigger('click')
    await flushPromises()

    const toastStore = useToastStore()
    expect(toastStore.toasts.some((t) => t.variant === 'error')).toBe(false)
    // Row reflects the race outcome — button gone since it's now finished.
    expect(wrapper.find('[data-testid="executions-stop-e-running"]').exists()).toBe(false)
  })
})

// El filtro por assignee (migración 057). A diferencia del chip de "pending",
// que es puramente cliente, éste es del SERVIDOR: la columna vive en
// execution_logs y el filtro se resuelve en SQL, así que lo que hay que probar
// es que el click dispare un refetch con el payload correcto.
describe('ExecutionsSection — filtro por assignee', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useProjectsStore()
    store.activeProjectId = 'p-1'
    fetchExecutionsMock.mockReset()
    currentRouteQuery = {}
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('descubre los chips a partir de los assignees de las filas cargadas', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-1', assignees: ['julianjab'] }),
      makeExec({ id: 'e-2', assignees: ['otro', 'julianjab'] }),
    ])

    // Un chip por persona, sin duplicar al que aparece en dos filas.
    expect(wrapper.find('[data-testid="executions-filter-assignee-chip-julianjab"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-testid="executions-filter-assignee-chip-otro"]').exists()).toBe(true)
  })

  it('no dibuja la sección cuando ninguna fila trae assignees', async () => {
    const wrapper = await mountWithExecs([makeExec({ id: 'e-1', assignees: null })])
    expect(wrapper.find('[data-testid^="executions-filter-assignee-chip-"]').exists()).toBe(false)
  })

  it('clickear un chip refetchea con el assignee en el payload', async () => {
    const wrapper = await mountWithExecs([makeExec({ id: 'e-1', assignees: ['julianjab'] })])
    fetchExecutionsMock.mockResolvedValueOnce([makeExec({ id: 'e-1', assignees: ['julianjab'] })])

    await wrapper.find('[data-testid="executions-filter-assignee-chip-julianjab"]').trigger('click')
    await flushPromises()

    const lastCall = fetchExecutionsMock.mock.calls.at(-1)?.[0] as { assignee?: string[] }
    expect(lastCall.assignee).toEqual(['julianjab'])
  })

  it('sin chips activos no manda el filtro', async () => {
    await mountWithExecs([makeExec({ id: 'e-1', assignees: ['julianjab'] })])
    const firstCall = fetchExecutionsMock.mock.calls.at(0)?.[0] as { assignee?: string[] }
    expect(firstCall.assignee).toBeUndefined()
  })
})
