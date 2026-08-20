import { describe, expect, test } from 'bun:test'
import type {
  IssueItem,
  PendingTaskInfo,
  PendingTaskRegistryPort,
  ProjectSource,
  SourceItem,
} from '../../contract.js'
import {
  CONCURRENCY_RETRY_FLOOR_MS,
  WebhookIssueManager,
  webhookFallbackMs,
} from '../webhook-issue-manager.js'
import { deliverWebhook, listWebhookTargets } from '../webhook-registry.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakePendingTasks(entries: Array<[string, PendingTaskInfo]> = []): PendingTaskRegistryPort {
  return {
    getPendingTask: () => undefined,
    listPendingTasks: () => entries,
    removePendingTask: () => {},
  }
}

function fakeSource(items: SourceItem[], overrides: Partial<ProjectSource> = {}): ProjectSource {
  return {
    kind: 'fake',
    getStatuses: async () => [],
    getItems: async () => items,
    getTransitionManager: (() => {
      throw new Error('not used')
    }) as ProjectSource['getTransitionManager'],
    ...overrides,
  } as ProjectSource
}

const item = (id: string, status: string): SourceItem => ({ id, title: id, status })

describe('WebhookIssueManager', () => {
  test('scans on startup and dispatches every fetched item — no status prefilter', async () => {
    // Whether an item actually triggers an agent is TaskDispatcher's call
    // (project/repo/status/when via selectAgent) — this manager no longer
    // filters by status before handing items off.
    const dispatched: IssueItem[] = []
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([item('i1', 'Todo'), item('i2', 'Done')]),
      () => {},
      fakePendingTasks(),
      0, // no debounce
      0, // no fallback interval
    )

    const sub = mgr.start(async (i) => {
      dispatched.push(i)
    })
    await sleep(20)

    expect(dispatched.map((d) => d.id).sort()).toEqual(['i1', 'i2'])
    expect(dispatched[0]?.projectId).toBe('p1')
    sub.dispose()
  })

  test('project filter gates items before dispatch — no status prefilter param, but filter still applies', async () => {
    // El filtro general de proyecto (project-filter.ts) es un nivel por
    // encima de selectAgent: un item que no lo pasa nunca llega a `dispatch`.
    const dispatched: IssueItem[] = []
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([item('i1', 'Todo'), item('i2', 'Done')]),
      () => {},
      fakePendingTasks(),
      0,
      0,
      undefined,
      undefined,
      { statusName: 'Done' },
    )

    const sub = mgr.start(async (i) => {
      dispatched.push(i)
    })
    await sleep(20)

    expect(dispatched.map((d) => d.id)).toEqual(['i2'])
    sub.dispose()
  })

  test('a delivery triggers a fresh scan with the source cache bypassed', async () => {
    const calls: Array<{ refresh?: boolean } | undefined> = []
    let items: SourceItem[] = []
    const dispatched: string[] = []
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([], {
        getItems: async (opts) => {
          calls.push(opts)
          return items
        },
      }),
      () => {},
      fakePendingTasks(),
      0,
      0,
    )
    const sub = mgr.start(async (i) => {
      dispatched.push(i.id)
    })
    await sleep(20)
    expect(dispatched).toEqual([])

    // Something changed upstream, then the webhook lands.
    items = [item('i9', 'Todo')]
    await deliverWebhook({ event: 'projects_v2_item' })
    await sleep(20)

    expect(dispatched).toEqual(['i9'])
    expect(calls.at(-1)).toEqual({ refresh: true })
    sub.dispose()
  })

  test('bursts are debounced into a single scan', async () => {
    let scans = 0
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([], {
        getItems: async () => {
          scans++
          return []
        },
      }),
      () => {},
      fakePendingTasks(),
      15, // debounce window
      0,
    )
    const sub = mgr.start(async () => {})
    await sleep(20)
    expect(scans).toBe(1) // startup scan

    mgr.trigger('a')
    mgr.trigger('b')
    mgr.trigger('c')
    await sleep(60)

    expect(scans).toBe(2)
    sub.dispose()
  })

  test('dispose unregisters the target and silences later triggers', async () => {
    let scans = 0
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([], {
        getItems: async () => {
          scans++
          return []
        },
      }),
      () => {},
      fakePendingTasks(),
      0,
      0,
    )
    const sub = mgr.start(async () => {})
    await sleep(20)
    expect(listWebhookTargets().some((t) => t.projectId === 'p1')).toBe(true)

    sub.dispose()
    expect(listWebhookTargets().some((t) => t.projectId === 'p1')).toBe(false)

    const before = scans
    mgr.trigger('after-dispose')
    await sleep(20)
    expect(scans).toBe(before)
  })

  test('no pull loop by default — a webhook project never scans on a timer', async () => {
    let scans = 0
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([], {
        getItems: async () => {
          scans++
          return []
        },
      }),
      () => {},
      fakePendingTasks(),
      0,
      webhookFallbackMs(), // default = 0 = off
    )
    const sub = mgr.start(async () => {})
    await sleep(20)
    expect(scans).toBe(1) // solo el catch-up de arranque

    // Sin timers: por más que pase el tiempo, nadie hace pull.
    await sleep(60)
    expect(scans).toBe(1)
    expect(mgr.stats().fallbackIntervalMs).toBe(0)

    // Un delivery real sí escanea.
    await deliverWebhook({ event: 'projects_v2_item' })
    await sleep(20)
    expect(scans).toBe(2)
    expect(mgr.stats().deliveryReceived).toBe(true)
    sub.dispose()
  })

  test('crashRecovery:false skips onDaemonStart but still does the first scan', async () => {
    let scans = 0
    let recovered = 0
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([], {
        getItems: async () => {
          scans++
          return []
        },
        onDaemonStart: async () => {
          recovered++
        },
      }),
      () => {},
      fakePendingTasks(),
      0,
      0,
      { crashRecovery: false, initialScan: true },
    )
    const sub = mgr.start(async () => {})
    await sleep(20)

    // Un manager nuevo en un reload: escanea (nadie más lo miraría en modo
    // webhook) pero NO corre crash-recovery, que le borraría el flag `working`
    // a runs en vuelo de otros proyectos.
    expect(recovered).toBe(0)
    expect(scans).toBe(1)

    // Sigue reaccionando a deliveries.
    await deliverWebhook({ event: 'projects_v2_item' })
    await sleep(20)
    expect(scans).toBe(2)
    sub.dispose()
  })

  test('crashRecovery without initialScan recovers but does not scan', async () => {
    // Boot con IA_FLOW_STARTUP_SCAN=0: hay que destrabar runs muertos sin
    // re-despachar todo (dev corre --watch y reinicia en cada save).
    let scans = 0
    let recovered = 0
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([item('i1', 'Todo')], {
        getItems: async () => {
          scans++
          return [item('i1', 'Todo')]
        },
        onDaemonStart: async () => {
          recovered++
        },
      }),
      () => {},
      fakePendingTasks(),
      0,
      0,
      { crashRecovery: true, initialScan: false },
    )
    const dispatched: string[] = []
    const sub = mgr.start(async (i) => {
      dispatched.push(i.id)
    })
    await sleep(20)

    expect(recovered).toBe(1)
    expect(scans).toBe(0)
    expect(dispatched).toEqual([])
    sub.dispose()
  })

  test('a reload of an already-running project does nothing on start', async () => {
    let scans = 0
    let recovered = 0
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([], {
        getItems: async () => {
          scans++
          return []
        },
        onDaemonStart: async () => {
          recovered++
        },
      }),
      () => {},
      fakePendingTasks(),
      0,
      0,
      { crashRecovery: false, initialScan: false },
    )
    const sub = mgr.start(async () => {})
    await sleep(20)
    expect(recovered).toBe(0)
    expect(scans).toBe(0)
    sub.dispose()
  })

  test('matches() delegates to the source, and matches everything without it', async () => {
    const withMatcher = new WebhookIssueManager(
      'p1',
      fakeSource([], { matchesWebhook: async (h) => h.projectNodeId === 'PVT_1' }),
      () => {},
      fakePendingTasks(),
      0,
      0,
    )
    expect(await withMatcher.matches({ projectNodeId: 'PVT_1' })).toBe(true)
    expect(await withMatcher.matches({ projectNodeId: 'PVT_2' })).toBe(false)

    const without = new WebhookIssueManager(
      'p2',
      fakeSource([]),
      () => {},
      fakePendingTasks(),
      0,
      0,
    )
    expect(await without.matches({ projectNodeId: 'anything' })).toBe(true)
  })

  test('hasWiredAgents=false skips the cycle before ever calling getItems', async () => {
    let calls = 0
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([], {
        getItems: async () => {
          calls++
          return []
        },
      }),
      () => {},
      fakePendingTasks(),
      0,
      0,
      {},
      () => false,
    )
    const sub = mgr.start(async () => {})
    await sleep(20)
    expect(calls).toBe(0)
    sub.dispose()
  })

  test('defaults to always-scan when hasWiredAgents is omitted', async () => {
    let calls = 0
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([], {
        getItems: async () => {
          calls++
          return []
        },
      }),
      () => {},
      fakePendingTasks(),
      0,
      0,
    )
    const sub = mgr.start(async () => {})
    await sleep(20)
    expect(calls).toBe(1)
    sub.dispose()
  })

  test('hasWiredAgents=false still scans when a pending task needs reconciliation', async () => {
    // An operator disabling/deleting the last agent for a project must not
    // orphan an already-in-flight run from divergence reconciliation.
    let calls = 0
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([], {
        getItems: async () => {
          calls++
          return []
        },
      }),
      () => {},
      fakePendingTasks([['task-1', { task: { projectId: 'p1' }, initialStatus: 'Todo' }]]),
      0,
      0,
      {},
      () => false,
    )
    const sub = mgr.start(async () => {})
    await sleep(20)
    expect(calls).toBe(1)
    sub.dispose()
  })

  test('reconciliation compares reconciliationStatus, not the frozen initialStatus', async () => {
    // set_task_field resyncs reconciliationStatus (not initialStatus) when
    // the agent moves its own task mid-run — the divergence loop must
    // follow that field, or it treats the agent's own legitimate move as
    // external drift and cancels a healthy run.
    const cancel = () => {
      cancelled = true
      return Promise.resolve()
    }
    let cancelled = false
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([item('task-1', 'Blocked')]),
      () => {},
      fakePendingTasks([
        [
          'task-1',
          {
            task: { projectId: 'p1' },
            initialStatus: 'Refine', // frozen — differs from the live status
            reconciliationStatus: 'Blocked', // resynced by set_task_field — matches
            cancel,
          },
        ],
      ]),
      0,
      0,
    )
    const sub = mgr.start(async () => {})
    await sleep(20)
    expect(cancelled).toBe(false)
    sub.dispose()
  })

  test('concurrency cap defers dispatches past the limit to a later cycle', async () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`i${i}`, 'Todo'))
    const dispatched: string[] = []
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource(items),
      () => {},
      fakePendingTasks(),
      0,
      0,
      {},
      undefined,
    )
    process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = '2'
    try {
      // Dispatch never resolves — holds each slot open so the cap actually
      // bites. Records the id synchronously, before returning the
      // never-resolving promise, so `dispatched` reflects what got started.
      const sub = mgr.start((i) => {
        dispatched.push(i.id)
        return new Promise(() => {})
      })
      await sleep(20)
      sub.dispose()
    } finally {
      delete process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES
    }
    expect(dispatched.length).toBe(2)
  })

  test('webhook mode retries once a dispatch frees a slot — no timer while nothing changed', async () => {
    // Push-only mode has no timer to fall back on — without this, items
    // deferred past the concurrency cap would sit stuck until an unrelated
    // delivery happened to land. Event-driven (onDispatchSlotFreed), debounced
    // by a short fixed floor rather than firing instantly (that would tight-
    // loop when a dispatch resolves fast — see CONCURRENCY_RETRY_FLOOR_MS).
    // `getItems` reports only i1 left after the retry, simulating the board
    // moving on, so the scenario actually converges instead of both items
    // perpetually re-triggering each other.
    let scans = 0
    let resolveFirst!: () => void
    const firstDispatchDone = new Promise<void>((r) => {
      resolveFirst = r
    })
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([], {
        getItems: async () => {
          scans++
          return scans === 1 ? [item('i0', 'Todo'), item('i1', 'Todo')] : [item('i1', 'Todo')]
        },
      }),
      () => {},
      fakePendingTasks(),
      0,
      0,
    )
    process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = '1'
    try {
      const sub = mgr.start((i) => (i.id === 'i0' ? firstDispatchDone : Promise.resolve()))
      await sleep(20)
      expect(scans).toBe(1) // i0 took the only slot, i1 deferred
      resolveFirst()
      await sleep(20)
      expect(scans).toBe(1) // slot freed, but the retry is debounced — not yet
      await sleep(CONCURRENCY_RETRY_FLOOR_MS + 100)
      expect(scans).toBe(2) // retried on its own once the floor elapsed
      sub.dispose()
    } finally {
      delete process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES
    }
  }, 10_000)

  test('concurrency-cap retries back off exponentially while the backlog is stuck, then reset once it drains', async () => {
    // The board holds steady at 3 items past a cap of 1 for the first three
    // scans (simulating a backlog too big for the cap — e.g. a status-less
    // agent matching more than IA_FLOW_MAX_CONCURRENT_DISPATCHES), then
    // drops to 1 item — real progress that should reset the backoff. Every
    // dispatch resolves instantly (e.g. "no agent matched"), so the slot
    // frees right away and onDispatchSlotFreed always has something to
    // retry — this is exactly the shape that produced the GraphQL-quota
    // exhaustion the backoff exists to bound.
    let scans = 0
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([], {
        getItems: async () => {
          scans++
          return scans <= 3
            ? [item('i0', 'Todo'), item('i1', 'Todo'), item('i2', 'Todo')]
            : [item('i0', 'Todo')]
        },
      }),
      () => {},
      fakePendingTasks(),
      0,
      0,
    )
    process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = '1'
    try {
      const sub = mgr.start(async () => {})
      await sleep(20)
      expect(scans).toBe(1) // startup: dispatched i0, skipped i1+i2 (unchanged)

      // Retry #1 fires at floor speed — consecutiveCapRetries was still 0.
      await sleep(CONCURRENCY_RETRY_FLOOR_MS + 100)
      expect(scans).toBe(2) // skipped 2 again — backlog hasn't shrunk

      // Retry #2 should now be backed off to 2x the floor, not floor again —
      // confirm it does NOT fire after only one more floor-length wait...
      await sleep(CONCURRENCY_RETRY_FLOOR_MS - 200)
      expect(scans).toBe(2) // would already be 3 with a fixed, non-backing-off floor

      // ...but does fire once the doubled interval elapses.
      await sleep(CONCURRENCY_RETRY_FLOOR_MS + 300)
      expect(scans).toBe(3) // skipped 2 again — this cycle still returns 3 items

      // The 4th getItems call (armed by retry #3, backed off to 4x the
      // floor) returns just i0 — skippedForConcurrency drops to 0, real
      // progress. The backoff resets, and with nothing left to skip no
      // further retry is armed at all, so scans stabilizes here.
      await sleep(CONCURRENCY_RETRY_FLOOR_MS * 4 + 300)
      expect(scans).toBe(4)
      sub.dispose()
    } finally {
      delete process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES
    }
  }, 20_000)
})
