import type { ExecutionLog } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Module mocks ─────────────────────────────────────────────────────────
// DashboardView pulls executions and polling status via axios wrappers on
// mount. Stub the two API modules so the test doesn't need a backend.

vi.mock('@/features/executions/api', () => ({
  fetchExecutions: vi.fn().mockResolvedValue([]),
  fetchActiveExecutions: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/features/projects/api', () => ({
  fetchPollingStatus: vi.fn().mockResolvedValue(null),
}))

// Router `push` is the assertion target: goExecution() must call it with
// the correct path + runId query for the row clicked.
const pushMock = vi.hoisted(() => vi.fn())
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import { useActiveExecutionsStore } from '@/features/executions/activeStore'
import { useProjectsStore } from '@/features/projects/store'
import DashboardView from './DashboardView.vue'

function makeExec(overrides: Partial<ExecutionLog>): ExecutionLog {
  return {
    id: 'e-default',
    projectId: 'p-1',
    taskId: 't-default',
    taskTitle: 'Default task',
    agentId: 'agent',
    providerId: 'anthropic-api',
    startedAt: '2025-01-01T00:00:00Z',
    finishedAt: null,
    outcome: null,
    errorMsg: null,
    stopReason: null,
    ...overrides,
  }
}

describe('DashboardView — click en ejecución navega con ?runId=', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    pushMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('click en fila del panel EN EJECUCIÓN abre /projects/<pid>/executions?runId=<eid>', async () => {
    const active = useActiveExecutionsStore()
    // Seed the store directly so the component's onMounted `if
    // (!loaded) fetch()` short-circuits and we don't need to stub the WS
    // hydration path.
    active.executions = [
      makeExec({ id: 'run-active-1', projectId: 'proj-alpha', taskTitle: 'Corriendo A' }),
    ]
    active.loaded = true

    const wrapper = mount(DashboardView)
    await flushPromises()

    const rows = wrapper.findAll('.run')
    expect(rows.length).toBeGreaterThan(0)
    await rows[0].trigger('click')

    expect(pushMock).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith({
      path: '/projects/proj-alpha/executions',
      query: { runId: 'run-active-1' },
    })
  })

  it('click en fila de ACTIVIDAD también navega con ?runId=', async () => {
    // Two rows come from different sources: the active store powers the
    // "EN EJECUCIÓN" panel and fetchExecutions() powers "ACTIVIDAD". Here
    // we prime `fetchExecutions` with a finished row so it renders in the
    // activity log but not the active panel.
    const api = await import('@/features/executions/api')
    vi.mocked(api.fetchExecutions).mockResolvedValueOnce([
      makeExec({
        id: 'run-past-1',
        projectId: 'proj-beta',
        taskTitle: 'Finalizado B',
        finishedAt: '2025-01-01T00:01:00Z',
        outcome: 'success',
      }),
    ])

    const active = useActiveExecutionsStore()
    active.loaded = true
    active.executions = []

    const wrapper = mount(DashboardView)
    await flushPromises()

    const activityRows = wrapper.findAll('.log__row')
    expect(activityRows.length).toBe(1)
    await activityRows[0].trigger('click')

    expect(pushMock).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith({
      path: '/projects/proj-beta/executions',
      query: { runId: 'run-past-1' },
    })
  })

  it('click en fila de la tabla PROYECTOS mantiene la navegación sin runId', async () => {
    // Regression guard: goProject() stays intact for the projects table.
    // If someone accidentally rewired the project rows to goExecution(),
    // the router would receive a runId here and this assertion would fail.
    const projects = useProjectsStore()
    projects.projects = [
      {
        id: 'proj-gamma',
        name: 'Gamma',
        source: null,
        archivedAt: null,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      } as unknown as (typeof projects.projects)[number],
    ]

    const active = useActiveExecutionsStore()
    active.loaded = true
    active.executions = []

    const wrapper = mount(DashboardView)
    await flushPromises()

    const projectRow = wrapper.get('.table__row')
    await projectRow.trigger('click')

    expect(pushMock).toHaveBeenCalledTimes(1)
    // goProject() uses the plain string form — no query object.
    expect(pushMock).toHaveBeenCalledWith('/projects/proj-gamma/executions')
  })
})
