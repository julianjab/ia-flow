import { describe, expect, test } from 'bun:test'
import type {
  IssueItem,
  PendingTaskInfo,
  PendingTaskRegistryPort,
  ProjectSource,
  SourceItem,
} from '../../contract.js'
import { WebhookIssueManager, webhookFallbackMs } from '../webhook-issue-manager.js'
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
})
