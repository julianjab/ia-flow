import type { ExecutionLog } from '@ia-flow/shared'
import { type VueWrapper, flushPromises, mount } from '@vue/test-utils'
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
  useRoute: () => ({ query: currentRouteQuery, params: {}, name: 'general' }),
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

/** Aplica un filtro como lo hace el operador: escribe `campo:valor` en el input
 *  y confirma. Con lista cerrada, Enter toma la opción resaltada (la primera,
 *  que es el match exacto de lo escrito). */
async function applyFilter(wrapper: VueWrapper, raw: string) {
  const input = wrapper.get('[data-testid="executions-filter-input"]')
  await input.setValue(raw)
  await input.trigger('keydown', { key: 'Enter' })
  await flushPromises()
}

function tokenFor(wrapper: VueWrapper, field: string, value: string) {
  return wrapper.find(`[data-testid="executions-filter-token-${field}-${value}"]`)
}

describe('ExecutionsSection — filtrar por resultado', () => {
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

  // El conteo es un atajo del token, no un segundo camino: escribe por el mismo
  // lugar que el input, así que lo que se prende ahí se ve como token.
  it('clickear un conteo prende y apaga su token', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e1', outcome: 'success' }),
      makeExec({ id: 'e2', outcome: 'error' }),
    ])
    fetchExecutionsMock.mockResolvedValue([makeExec({ id: 'e2', outcome: 'error' })])

    const chip = wrapper.get('[data-testid="executions-summary-error"]')
    expect(chip.attributes('aria-pressed')).toBe('false')

    await chip.trigger('click')
    await flushPromises()
    expect(tokenFor(wrapper, 'resultado', 'error').exists()).toBe(true)
    expect(chip.attributes('aria-pressed')).toBe('true')
    expect(fetchExecutionsMock.mock.calls.at(-1)?.[0]).toMatchObject({ outcome: ['error'] })

    await chip.trigger('click')
    await flushPromises()
    expect(tokenFor(wrapper, 'resultado', 'error').exists()).toBe(false)
    expect(fetchExecutionsMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('outcome')
  })

  it('`resultado:pending` deja sólo las filas sin outcome', async () => {
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

    // Sanity: las 3 filas antes de filtrar.
    expect(wrapper.findAll('.exec-card')).toHaveLength(3)
    expect(tokenFor(wrapper, 'resultado', 'pending').exists()).toBe(false)

    await applyFilter(wrapper, 'resultado:pending')

    const rows = wrapper.findAll('.exec-card')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('Running task')
    expect(tokenFor(wrapper, 'resultado', 'pending').exists()).toBe(true)
  })

  it('quitar el token restaura todas las ejecuciones', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e1', outcome: 'success' }),
      makeExec({ id: 'e2', outcome: null, finishedAt: null }),
      makeExec({ id: 'e3', outcome: 'cancelled' }),
    ])

    await applyFilter(wrapper, 'resultado:pending')
    expect(wrapper.findAll('.exec-card')).toHaveLength(1)

    await tokenFor(wrapper, 'resultado', 'pending').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.exec-card')).toHaveLength(3)
  })

  it('`pending` se resuelve en cliente y no refetchea', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e1', outcome: 'success' }),
      makeExec({ id: 'e2', outcome: null, finishedAt: null }),
    ])

    expect(fetchExecutionsMock).toHaveBeenCalledTimes(1)

    await applyFilter(wrapper, 'resultado:pending')

    // Pending is purely client-side — no extra network call.
    expect(fetchExecutionsMock).toHaveBeenCalledTimes(1)
  })

  // `resultado:error` + `resultado:pending` es "lo que falló, más lo que todavía
  // corre". Mandando `outcome` al servidor la combinación devolvía SIEMPRE
  // vacío: la página ya venía sin las filas de outcome nulo.
  it('`pending` junto a otro resultado suma, no resta', async () => {
    const rows = [
      makeExec({ id: 'e-ok', taskTitle: 'Done', outcome: 'success' }),
      makeExec({ id: 'e-err', taskTitle: 'Broken', outcome: 'error' }),
      makeExec({ id: 'e-run', taskTitle: 'Running', outcome: null, finishedAt: null }),
    ]
    const wrapper = await mountWithExecs(rows)
    fetchExecutionsMock.mockResolvedValue(rows)

    await applyFilter(wrapper, 'resultado:error')
    await applyFilter(wrapper, 'resultado:pending')

    const texts = wrapper.findAll('.exec-card').map((c) => c.text())
    expect(texts).toHaveLength(2)
    expect(texts.join(' ')).toContain('Broken')
    expect(texts.join(' ')).toContain('Running')
    // El servidor deja de filtrar por outcome: si no, no habría mandado la fila
    // sin outcome que el OR necesita.
    expect(fetchExecutionsMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('outcome')
  })

  it('`resultado:error` sí refetchea con el outcome en el payload', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e1', outcome: 'success' }),
      makeExec({ id: 'e2', outcome: 'error' }),
    ])
    expect(fetchExecutionsMock).toHaveBeenCalledTimes(1)

    // The second call to fetchExecutions will resolve with the "filtered"
    // page — value doesn't matter for the assertion, just that it resolves.
    fetchExecutionsMock.mockResolvedValueOnce([makeExec({ id: 'e2', outcome: 'error' })])

    await applyFilter(wrapper, 'resultado:error')

    expect(fetchExecutionsMock).toHaveBeenCalledTimes(2)
    const secondCallArg = fetchExecutionsMock.mock.calls[1]?.[0] as { outcome?: string[] }
    expect(secondCallArg.outcome).toEqual(['error'])

    // `error` no prende el flag de pending: son dos valores del mismo campo.
    expect(tokenFor(wrapper, 'resultado', 'pending').exists()).toBe(false)
    expect(tokenFor(wrapper, 'resultado', 'error').exists()).toBe(true)
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
    // auto-expand path is pure UI. Filtrar por resultado después sigue
    // refetcheando con el outcome, sin que el runId se meta en el payload.
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
    await applyFilter(wrapper, 'resultado:error')

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

// El filtro por assignee (migración 057). A diferencia de `resultado:pending`,
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

  // La lista de agentes sale de un fetch que puede fallar o llegar tarde, y la
  // de assignees de las filas cargadas: con lista cerrada, vacía = campo
  // imposible de filtrar.
  it('acepta un agente que todavía no está en las sugerencias', async () => {
    const wrapper = await mountWithExecs([makeExec({ id: 'e-1' })])
    fetchExecutionsMock.mockResolvedValue([makeExec({ id: 'e-1' })])

    const input = wrapper.get('[data-testid="executions-filter-input"]')
    await input.setValue('agente:refiner')
    expect(wrapper.findAll('.fq-option')).toHaveLength(0)
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(fetchExecutionsMock.mock.calls.at(-1)?.[0]).toMatchObject({ agentId: ['refiner'] })
  })

  // El enum lo valida el servidor: un valor inventado sería un 400.
  it('`resultado` sigue sin aceptar cualquier cosa', async () => {
    const wrapper = await mountWithExecs([makeExec({ id: 'e-1' })])
    const calls = fetchExecutionsMock.mock.calls.length

    await applyFilter(wrapper, 'resultado:explotó')

    expect(wrapper.findAll('.fq-token')).toHaveLength(0)
    expect(fetchExecutionsMock.mock.calls).toHaveLength(calls)
  })

  it('sugiere los assignees de las filas cargadas', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-1', assignees: ['julianjab'] }),
      makeExec({ id: 'e-2', assignees: ['otro', 'julianjab'] }),
    ])

    const input = wrapper.get('[data-testid="executions-filter-input"]')
    await input.setValue('assignee:')

    // Una opción por persona, sin duplicar al que aparece en dos filas.
    expect(wrapper.findAll('.fq-option').map((o) => o.text())).toEqual(['julianjab', 'otro'])
  })

  it('sin assignees en las filas, el campo no ofrece valores', async () => {
    const wrapper = await mountWithExecs([makeExec({ id: 'e-1', assignees: null })])

    const input = wrapper.get('[data-testid="executions-filter-input"]')
    await input.setValue('assignee:')
    expect(wrapper.findAll('.fq-option')).toHaveLength(0)
  })

  it('elegir un assignee refetchea con el payload', async () => {
    const wrapper = await mountWithExecs([makeExec({ id: 'e-1', assignees: ['julianjab'] })])
    fetchExecutionsMock.mockResolvedValueOnce([makeExec({ id: 'e-1', assignees: ['julianjab'] })])

    await applyFilter(wrapper, 'assignee:julianjab')

    const lastCall = fetchExecutionsMock.mock.calls.at(-1)?.[0] as { assignee?: string[] }
    expect(lastCall.assignee).toEqual(['julianjab'])
  })

  it('sin token no manda el filtro', async () => {
    await mountWithExecs([makeExec({ id: 'e-1', assignees: ['julianjab'] })])
    const firstCall = fetchExecutionsMock.mock.calls.at(0)?.[0] as { assignee?: string[] }
    expect(firstCall.assignee).toBeUndefined()
  })
})

// ─── Agrupación por disparo de regla (migración 065) ──────────────────────
// Desde que las acciones de una regla escriben su fila en `execution_logs`,
// una "ejecución" puede ser un `script` o un `http`. Las que corrieron por el
// mismo evento se leen juntas: es la diferencia entre una lista de cosas
// sueltas y la historia de lo que hizo el pipeline.
describe('ExecutionsSection — el disparo de una regla es una fila', () => {
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

  const firing = (over: Partial<ExecutionLog>): ExecutionLog =>
    makeExec({ eventId: 'ev-1', ruleId: 'ia-flow-refine', eventType: 'issue.scanned', ...over })

  const script = (over: Partial<ExecutionLog> = {}): ExecutionLog =>
    firing({
      id: 'e-notif',
      kind: 'script',
      agentId: 'notify-slack',
      providerId: '',
      position: 0,
      startedAt: '2025-01-01T00:00:09Z',
      finishedAt: '2025-01-01T00:00:09.2Z',
      ...over,
    })

  const agent = (over: Partial<ExecutionLog> = {}): ExecutionLog =>
    firing({
      id: 'e-agent',
      agentId: 'refiner',
      position: 1,
      startedAt: '2025-01-01T00:00:10Z',
      finishedAt: '2025-01-01T00:02:32Z',
      ...over,
    })

  // Un run de agente y una acción comparten tabla pero no columnas: dibujar las
  // que no aplican hace que el detalle mienta sobre lo que se sabe.
  it('el detalle de una acción muestra su regla y su lugar, no campos de agente', async () => {
    const wrapper = await mountWithExecs([agent(), script({ errorMsg: '200 OK' })])
    await wrapper.find('.exec-card--firing .exec-row').trigger('click')
    await wrapper.findAll('.exec-card')[1].find('.exec-row').trigger('click')
    await flushPromises()

    const drawer = wrapper.get('[data-testid="executions-detail-drawer"]')
    const labels = drawer.findAll('.detail-label').map((l) => l.text())
    expect(drawer.text()).toContain('Acción')
    expect(labels).toContain('regla')
    expect(labels).toContain('posición en el do[]')
    expect(labels).toContain('evento')
    // Nada de lo que una acción no tiene.
    expect(labels).not.toContain('providerId')
    expect(labels).not.toContain('stopReason')
    expect(labels).not.toContain('assignees')
    // `errorMsg` guarda el detalle cuando salió bien: rotularlo "error" haría
    // leer un `success` con "errorMsg: 200 OK".
    expect(labels).toContain('detalle')
    expect(labels).not.toContain('error')
  })

  it('el detalle de un run de agente conserva sus campos', async () => {
    const wrapper = await mountWithExecs([agent(), script()])
    await wrapper.find('.exec-card--firing .exec-row').trigger('click')
    await wrapper.findAll('.exec-card')[2].find('.exec-row').trigger('click')
    await flushPromises()

    const drawer = wrapper.get('[data-testid="executions-detail-drawer"]')
    const labels = drawer.findAll('.detail-label').map((l) => l.text())
    expect(drawer.text()).toContain('Ejecución')
    expect(labels).toContain('agentId')
    expect(labels).toContain('providerId')
    // Y de dónde vino, que antes no se veía en ningún lado.
    expect(labels).toContain('regla')
    expect(labels).not.toContain('posición en el do[]')
  })

  it('se filtra por la regla que disparó, y por qué corrió', async () => {
    const wrapper = await mountWithExecs([agent(), script()])
    fetchExecutionsMock.mockResolvedValue([script()])

    const input = wrapper.get('[data-testid="executions-filter-input"]')
    // Las sugerencias salen de las filas cargadas; `agent` está siempre porque
    // es lo que pide "sólo los runs", sin las acciones.
    await input.setValue('regla:')
    expect(wrapper.findAll('.fq-option__value').map((o) => o.text())).toEqual(['ia-flow-refine'])
    await input.setValue('tipo:')
    expect(wrapper.findAll('.fq-option__value').map((o) => o.text())).toEqual(['agent', 'script'])

    await applyFilter(wrapper, 'regla:ia-flow-refine')
    expect(fetchExecutionsMock.mock.calls.at(-1)?.[0]).toMatchObject({
      ruleId: ['ia-flow-refine'],
    })

    await applyFilter(wrapper, 'tipo:script')
    expect(fetchExecutionsMock.mock.calls.at(-1)?.[0]).toMatchObject({ kind: ['script'] })
  })

  it('colapsa las acciones en una sola fila resumen', async () => {
    const wrapper = await mountWithExecs([agent(), script()])

    const cards = wrapper.findAll('.exec-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].classes()).toContain('exec-card--firing')
    // El resumen es del disparo: la regla, no la primera acción.
    expect(cards[0].text()).toContain('ia-flow-refine')
    expect(cards[0].text()).toContain('2 acciones')
    // El título de la tarea se dice UNA vez, no una por acción.
    expect(cards[0].text().match(/Default task/g)).toHaveLength(1)
  })

  it('al abrirlo cuelga sus acciones en el orden del `do[]`', async () => {
    const wrapper = await mountWithExecs([agent(), script()])

    await wrapper.find('.exec-card--firing .exec-row').trigger('click')

    const cards = wrapper.findAll('.exec-card')
    expect(cards).toHaveLength(3)
    // Las dos cuelgan de la regla — ninguna es padre de la otra.
    expect(cards[1].classes()).toContain('exec-card--nested')
    expect(cards[2].classes()).toContain('exec-card--nested')
    // Adentro manda `position`: primero corrió la notificación.
    expect(cards[1].find('.exec-kind').text()).toBe('acción')
    expect(cards[1].find('.exec-action-kind').text()).toBe('script')
    expect(cards[2].find('.exec-kind').text()).toBe('agente')
    // El nombre va en la columna del agente, que es donde el encabezado lo
    // anuncia — y una acción NO cae al `ruleId`, que ya dijo el resumen.
    expect(cards[1].find('.exec-agent').text()).toBe('notify-slack')
    expect(cards[2].find('.exec-agent').text()).toBe('refiner')
    // Y no repiten el título que ya dijo el resumen.
    expect(cards[1].text()).not.toContain('Default task')
  })

  it('una acción sin nombre deja vacía la columna del agente', async () => {
    const wrapper = await mountWithExecs([agent(), script({ agentId: '' })])
    await wrapper.find('.exec-card--firing .exec-row').trigger('click')

    // Una acción inline no tiene nombre: la identifica su regla más su
    // posición, y caer al `ruleId` la haría parecer otro run del agente.
    expect(wrapper.findAll('.exec-card')[1].find('.exec-agent').text()).toBe('')
  })

  it('el resumen abarca de la primera acción a la última', async () => {
    const wrapper = await mountWithExecs([agent(), script()])

    const summary = wrapper.find('.exec-card--firing')
    // Arrancó con el script (00:00:09), no con el run que quedó arriba en el
    // orden del listado, y duró hasta que cerró el agente (00:02:32).
    expect(summary.find('.exec-date').attributes('title')).toBe('2025-01-01T00:00:09Z')
    expect(summary.find('.exec-duration').text()).toBe('2m 23s')
    expect(summary.find('.exec-outcome').text()).toBe('success')
  })

  it('un disparo con algo vivo está pending, y ahí va el botón de detener', async () => {
    const wrapper = await mountWithExecs([
      agent({ finishedAt: null, outcome: null }),
      script({ outcome: 'error' }),
    ])

    const summary = wrapper.find('.exec-card--firing')
    expect(summary.find('.exec-outcome').text()).toBe('pending')
    expect(summary.find('[data-testid="executions-stop-e-agent"]').exists()).toBe(true)
  })

  it('cerrado, el disparo se lleva el peor resultado de sus acciones', async () => {
    const wrapper = await mountWithExecs([agent(), script({ outcome: 'error' })])

    expect(wrapper.find('.exec-card--firing .exec-outcome').text()).toBe('error')
  })

  it('un disparo de una sola fila no se colapsa', async () => {
    const wrapper = await mountWithExecs([agent({ id: 'solo' })])

    const cards = wrapper.findAll('.exec-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].classes()).not.toContain('exec-card--firing')
    expect(cards[0].text()).toContain('Default task')
  })

  it('una fila sin evento sale plana', async () => {
    const wrapper = await mountWithExecs([
      makeExec({ id: 'e-manual-1' }),
      makeExec({ id: 'e-manual-2' }),
    ])

    const cards = wrapper.findAll('.exec-card')
    expect(cards).toHaveLength(2)
    expect(cards.every((c) => !c.classes().includes('exec-card--nested'))).toBe(true)
  })

  it('dos disparos distintos no se mezclan', async () => {
    const wrapper = await mountWithExecs([
      agent(),
      script(),
      firing({ id: 'b1', eventId: 'ev-2', position: 0 }),
    ])

    const cards = wrapper.findAll('.exec-card')
    // El resumen de `ev-1` y la fila suelta de `ev-2`.
    expect(cards).toHaveLength(2)
    expect(cards.filter((c) => c.classes().includes('exec-card--firing'))).toHaveLength(1)
  })
})
