import type { ExecutionLog } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Module mocks ─────────────────────────────────────────────────────────
// The dashboard hits `/api/executions` and `/api/projects/:id/polling` on
// mount. Stub both so the test doesn't need a live backend, then seed the
// active-executions store directly so the "EN EJECUCIÓN" list renders a row
// without going through the WS lifecycle.

const fetchExecutionsMock = vi.fn<[unknown], Promise<ExecutionLog[]>>()
vi.mock('@/features/executions/api', () => ({
  fetchExecutions: (filters: unknown) => fetchExecutionsMock(filters),
  // Not called in this test — the store is pre-populated before mount — but
  // the module barrel exports it, so keep the surface complete.
  fetchActiveExecutions: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/features/projects/api', () => ({
  fetchPollingStatus: vi.fn().mockResolvedValue({ paused: false }),
  fetchProjects: vi.fn().mockResolvedValue([]),
}))

// Capture every router.push so we can assert the exact target the handler
// asked for. A single spy is shared by both `useRouter` calls (only one is
// made in this view but keeping it shared makes assertions trivial).
const pushSpy = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushSpy }),
}))

import { useActiveExecutionsStore } from '@/features/executions/activeStore'
import { useProjectsStore } from '@/features/projects/store'
import DashboardView from './DashboardView.vue'

function makeExec(overrides: Partial<ExecutionLog>): ExecutionLog {
  return {
    id: 'e-default',
    projectId: 'p-default',
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

async function mountDashboard(opts: {
  active: ExecutionLog[]
  recent: ExecutionLog[]
}) {
  fetchExecutionsMock.mockResolvedValueOnce(opts.recent)
  const activeStore = useActiveExecutionsStore()
  // Skip the fetch path by marking the store as already hydrated with the
  // in-flight rows we care about.
  activeStore.executions = opts.active
  activeStore.loaded = true
  const wrapper = mount(DashboardView)
  await flushPromises()
  return wrapper
}

describe('DashboardView — click en una ejecución navega con ?runId', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Projects list is queried for polling status; leaving it empty avoids
    // extra network calls and keeps the assertions focused on the click
    // handlers.
    const projects = useProjectsStore()
    projects.projects = []
    fetchExecutionsMock.mockReset()
    pushSpy.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('pushes to /projects/<projectId>/executions?runId=<id> when a row in "EN EJECUCIÓN" is clicked', async () => {
    const running = makeExec({
      id: 'run-42',
      projectId: 'proj-alpha',
      taskTitle: 'Deploy service',
    })
    const wrapper = await mountDashboard({ active: [running], recent: [] })

    // The panel renders `.run` cards; there should be exactly one row.
    const rows = wrapper.findAll('.run')
    expect(rows).toHaveLength(1)

    await rows[0].trigger('click')

    // The push payload matches the object form used by `goExecution` — the
    // reviewer script asserts on `{ path, query }` explicitly so a stray
    // string URL would fail here.
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(pushSpy).toHaveBeenCalledWith({
      path: '/projects/proj-alpha/executions',
      query: { runId: 'run-42' },
    })
  })

  it('pushes to /projects/<projectId>/executions?runId=<id> when a row in "ACTIVIDAD" is clicked', async () => {
    const done = makeExec({
      id: 'run-77',
      projectId: 'proj-beta',
      taskTitle: 'Refactor auth',
      finishedAt: '2025-01-01T00:00:05Z',
      outcome: 'success',
    })
    const wrapper = await mountDashboard({ active: [], recent: [done] })

    const rows = wrapper.findAll('.log__row')
    expect(rows).toHaveLength(1)

    await rows[0].trigger('click')

    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(pushSpy).toHaveBeenCalledWith({
      path: '/projects/proj-beta/executions',
      query: { runId: 'run-77' },
    })
  })

  it('does not attach a runId when a project row is clicked (goProject preserved)', async () => {
    // Regression guard: `goProject` should stay as-is for project rows —
    // there's no single execution to focus on when clicking a project card.
    const projects = useProjectsStore()
    projects.projects = [
      // Minimal shape sufficient for the row to render — fields the template
      // reads are `id` and `name`.
      { id: 'proj-alpha', name: 'Alpha' } as never,
    ]

    const wrapper = await mountDashboard({ active: [], recent: [] })

    const projectRows = wrapper.findAll('[data-kbd-list="dashboard-projects"] .table__row')
    expect(projectRows).toHaveLength(1)

    await projectRows[0].trigger('click')

    expect(pushSpy).toHaveBeenCalledTimes(1)
    // `goProject` uses the string form of `router.push` — no query object.
    expect(pushSpy).toHaveBeenCalledWith('/projects/proj-alpha/executions')
  })
})
