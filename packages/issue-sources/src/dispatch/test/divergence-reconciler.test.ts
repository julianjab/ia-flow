import { describe, expect, test } from 'bun:test'
import type {
  PendingTaskInfo,
  PendingTaskRegistryPort,
  ProjectSource,
  SourceItem,
} from '../../contract.js'
import { DivergenceReconciler } from '../divergence-reconciler.js'

function makeSource(
  items: SourceItem[],
  opts: { withGetItemById?: boolean } = {},
): ProjectSource & { getItemByIdCalls: string[]; getItemsCalls: number } {
  const getItemByIdCalls: string[] = []
  let getItemsCalls = 0
  const base: ProjectSource & { getItemByIdCalls: string[]; getItemsCalls: number } = {
    kind: 'test',
    getStatuses: async () => [],
    getItems: async () => {
      getItemsCalls++
      return items
    },
    // DivergenceReconciler never calls watch() — it's driven by its own
    // timer, independent of any source's push mechanism (see the module doc).
    watch: () => {
      throw new Error('DivergenceReconciler should never call watch()')
    },
    getItemByIdCalls,
    get getItemsCalls() {
      return getItemsCalls
    },
  }
  if (opts.withGetItemById !== false) {
    base.getItemById = async (id: string) => {
      getItemByIdCalls.push(id)
      return items.find((i) => i.id === id) ?? null
    }
  }
  return base
}

function makePendingRegistry(
  entries: Array<[string, PendingTaskInfo]>,
): PendingTaskRegistryPort & { removed: string[] } {
  const removed: string[] = []
  return {
    removed,
    getPendingTask: (id: string) => entries.find(([taskId]) => taskId === id)?.[1],
    listPendingTasks: () => entries,
    removePendingTask: (id: string) => {
      removed.push(id)
    },
  }
}

function pending(overrides: Partial<PendingTaskInfo> & { projectId: string }): PendingTaskInfo {
  return {
    task: { projectId: overrides.projectId },
    initialStatus: overrides.initialStatus ?? 'build',
    reconciliationStatus: overrides.reconciliationStatus,
    cancel: overrides.cancel,
  }
}

describe('DivergenceReconciler', () => {
  test('cancels a task whose status drifted from initialStatus', async () => {
    const source = makeSource([{ id: 't1', title: 'x', status: 'blocked' }])
    let cancelled = false
    const registry = makePendingRegistry([
      [
        't1',
        pending({
          projectId: 'p1',
          initialStatus: 'build',
          cancel: async () => {
            cancelled = true
          },
        }),
      ],
    ])
    const reconciler = new DivergenceReconciler({
      resolveSource: () => source,
      pendingTasks: registry,
    })
    await reconciler.tick()
    expect(cancelled).toBe(true)
    expect(registry.removed).toEqual(['t1'])
  })

  test('does not cancel when status matches initialStatus', async () => {
    const source = makeSource([{ id: 't1', title: 'x', status: 'build' }])
    const registry = makePendingRegistry([
      ['t1', pending({ projectId: 'p1', initialStatus: 'build' })],
    ])
    const reconciler = new DivergenceReconciler({
      resolveSource: () => source,
      pendingTasks: registry,
    })
    await reconciler.tick()
    expect(registry.removed).toEqual([])
  })

  test('compares against reconciliationStatus, not the frozen initialStatus', async () => {
    // The agent itself moved the task to "working" mid-run (onProcess) — the
    // source now reflects that as "working" too. Comparing against the
    // frozen initialStatus ("build") would misread this as external drift.
    const source = makeSource([{ id: 't1', title: 'x', status: 'working' }])
    const registry = makePendingRegistry([
      ['t1', pending({ projectId: 'p1', initialStatus: 'build', reconciliationStatus: 'working' })],
    ])
    const reconciler = new DivergenceReconciler({
      resolveSource: () => source,
      pendingTasks: registry,
    })
    await reconciler.tick()
    expect(registry.removed).toEqual([])
  })

  test('leaves the task alone when the source no longer returns it', async () => {
    const source = makeSource([]) // closed/deleted/transient gap
    const registry = makePendingRegistry([
      ['t1', pending({ projectId: 'p1', initialStatus: 'build' })],
    ])
    const reconciler = new DivergenceReconciler({
      resolveSource: () => source,
      pendingTasks: registry,
    })
    await reconciler.tick()
    expect(registry.removed).toEqual([])
  })

  test('groups pending tasks by project and resolves each source once', async () => {
    const sourceA = makeSource([{ id: 'a1', title: 'x', status: 'blocked' }])
    const sourceB = makeSource([{ id: 'b1', title: 'y', status: 'build' }])
    const registry = makePendingRegistry([
      ['a1', pending({ projectId: 'projA', initialStatus: 'build' })],
      ['b1', pending({ projectId: 'projB', initialStatus: 'build' })],
    ])
    const resolved: string[] = []
    const reconciler = new DivergenceReconciler({
      resolveSource: (projectId) => {
        resolved.push(projectId)
        return projectId === 'projA' ? sourceA : sourceB
      },
      pendingTasks: registry,
    })
    await reconciler.tick()
    expect(resolved.sort()).toEqual(['projA', 'projB'])
    expect(registry.removed).toEqual(['a1'])
  })

  test('falls back to a single filtered getItems() when the source has no getItemById', async () => {
    const source = makeSource([{ id: 't1', title: 'x', status: 'blocked' }], {
      withGetItemById: false,
    })
    const registry = makePendingRegistry([
      ['t1', pending({ projectId: 'p1', initialStatus: 'build' })],
      ['t2', pending({ projectId: 'p1', initialStatus: 'build' })], // absent from source, ignored
    ])
    const reconciler = new DivergenceReconciler({
      resolveSource: () => source,
      pendingTasks: registry,
    })
    await reconciler.tick()
    expect(source.getItemsCalls).toBe(1) // one fetch shared across both pending tasks
    expect(registry.removed).toEqual(['t1'])
  })

  test('tasks with no projectId are skipped (nothing to reconcile against)', async () => {
    const registry = makePendingRegistry([['t1', { task: {}, initialStatus: 'build' }]])
    const reconciler = new DivergenceReconciler({
      resolveSource: () => {
        throw new Error('should not be called')
      },
      pendingTasks: registry,
    })
    await reconciler.tick()
    expect(registry.removed).toEqual([])
  })

  test('start()/dispose() runs tick() on the configured interval and stops cleanly', async () => {
    const source = makeSource([{ id: 't1', title: 'x', status: 'blocked' }])
    let cancelled = 0
    const registry = makePendingRegistry([
      [
        't1',
        pending({
          projectId: 'p1',
          initialStatus: 'build',
          cancel: async () => {
            cancelled++
          },
        }),
      ],
    ])
    const reconciler = new DivergenceReconciler({
      resolveSource: () => source,
      pendingTasks: registry,
      intervalMs: 5,
    })
    const disposable = reconciler.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    disposable.dispose()
    expect(cancelled).toBeGreaterThan(0)
  })
})
