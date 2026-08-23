import { afterEach, describe, expect, test } from 'bun:test'
import type {
  Disposable,
  IssueItem,
  PendingTaskInfo,
  PendingTaskRegistryPort,
  ProjectSource,
  SourceItem,
} from '../../contract.js'
import { SourceDispatcher } from '../source-dispatcher.js'

// SourceDispatcher no longer decides HOW items arrive — that's each source's
// own watch(). These tests exercise what's still the dispatcher's job: the
// boot scan, the project filter, catch-up flags, the hasWiredAgents gate,
// and the concurrency cap + its local-buffer retry. Debounce/refresh
// semantics per delivery live in each source's own test file (see
// github-issues/test/source.test.ts, github-project/test/source.test.ts).

function makeSource(items: SourceItem[] = []): {
  source: ProjectSource
  getItemsCalls: () => number
  emit: (batch: SourceItem[]) => void
} {
  let getItemsCalls = 0
  let capturedOnItems: ((items: SourceItem[]) => void) | null = null
  const source: ProjectSource = {
    kind: 'test',
    getStatuses: async () => [],
    getItems: async () => {
      getItemsCalls++
      return items
    },
    watch: (onItems) => {
      capturedOnItems = onItems
      return { dispose: () => {} }
    },
  }
  return {
    source,
    getItemsCalls: () => getItemsCalls,
    emit: (batch) => capturedOnItems?.(batch),
  }
}

function makeItem(id: string, overrides: Partial<SourceItem> = {}): SourceItem {
  return { id, title: id, status: 'build', ...overrides }
}

function makePendingRegistry(
  entries: Array<[string, PendingTaskInfo]> = [],
): PendingTaskRegistryPort & { add: (id: string, projectId?: string) => void } {
  const map = new Map(entries)
  return {
    getPendingTask: (id) => map.get(id),
    listPendingTasks: () => [...map.entries()],
    removePendingTask: (id) => map.delete(id),
    // Stands in for Agent.run's registerPendingTask — the moment a dispatch
    // stops being an evaluation and becomes a running agent.
    add: (id, projectId = 'p1') =>
      map.set(id, { task: { projectId }, initialStatus: 'build' } as PendingTaskInfo),
  }
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('SourceDispatcher — boot scan', () => {
  test('dispatches every item returned by the boot getItems() scan', async () => {
    const { source } = makeSource([makeItem('a'), makeItem('b')])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
    })
    await flush()
    expect(dispatched.sort()).toEqual(['a', 'b'])
    disposable.dispose()
  })

  test('items pushed later via watch() also dispatch, through the same gates', async () => {
    const { source, emit } = makeSource([])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
    })
    await flush()
    emit([makeItem('c')])
    await flush()
    expect(dispatched).toEqual(['c'])
    disposable.dispose()
  })
})

describe('SourceDispatcher — project filter', () => {
  test('items failing the filter never reach dispatch', async () => {
    const { source } = makeSource([
      makeItem('a', { status: 'build' }),
      makeItem('b', { status: 'other' }),
    ])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
      undefined,
      { statusName: 'build' },
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
    })
    await flush()
    expect(dispatched).toEqual(['a'])
    disposable.dispose()
  })
})

describe('SourceDispatcher — catch-up flags', () => {
  test('crashRecovery:false skips onDaemonStart but still runs the initial scan', async () => {
    let onDaemonStartCalls = 0
    const { source } = makeSource([makeItem('a')])
    source.onDaemonStart = async () => {
      onDaemonStartCalls++
    }
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
      undefined,
      undefined,
      { crashRecovery: false, initialScan: true },
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
    })
    await flush()
    expect(onDaemonStartCalls).toBe(0)
    expect(dispatched).toEqual(['a'])
    disposable.dispose()
  })

  test('crashRecovery:true + initialScan:false runs recovery but no boot scan', async () => {
    let onDaemonStartCalls = 0
    const { source, getItemsCalls } = makeSource([makeItem('a')])
    source.onDaemonStart = async () => {
      onDaemonStartCalls++
    }
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
      undefined,
      undefined,
      { crashRecovery: true, initialScan: false },
    )
    const disposable = dispatcher.start(async () => {})
    await flush()
    expect(onDaemonStartCalls).toBe(1)
    expect(getItemsCalls()).toBe(0)
    disposable.dispose()
  })
})

describe('SourceDispatcher — hasWiredAgents gate', () => {
  test('skips the boot scan entirely when no agent is wired and nothing pending', async () => {
    const { source, getItemsCalls } = makeSource([makeItem('a')])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
      () => false,
    )
    const disposable = dispatcher.start(async () => {})
    await flush()
    expect(getItemsCalls()).toBe(0)
    disposable.dispose()
  })

  test('still scans when nothing is wired but a task for this project is pending', async () => {
    const { source, getItemsCalls } = makeSource([makeItem('a')])
    const pendingTasks = makePendingRegistry([
      ['x', { task: { projectId: 'p1' }, initialStatus: 'build' }],
    ])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      pendingTasks,
      'webhook',
      () => false,
    )
    const disposable = dispatcher.start(async () => {})
    await flush()
    expect(getItemsCalls()).toBe(1)
    disposable.dispose()
  })

  test('defaults to always-scan without a hasWiredAgents override', async () => {
    const { source, getItemsCalls } = makeSource([])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
    )
    const disposable = dispatcher.start(async () => {})
    await flush()
    expect(getItemsCalls()).toBe(1)
    disposable.dispose()
  })
})

describe('SourceDispatcher — capacity', () => {
  const originalRunCap = process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES
  const originalEvalCap = process.env.IA_FLOW_MAX_CONCURRENT_EVALUATIONS

  afterEach(() => {
    for (const [key, original] of [
      ['IA_FLOW_MAX_CONCURRENT_DISPATCHES', originalRunCap],
      ['IA_FLOW_MAX_CONCURRENT_EVALUATIONS', originalEvalCap],
    ] as const) {
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    }
  })

  test('the run cap counts running agents, not items under evaluation', async () => {
    process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = '1'
    const { source, emit } = makeSource([])
    const pending = makePendingRegistry()
    const dispatcher = new SourceDispatcher('p1', source, () => {}, pending, 'webhook')
    const dispatched: string[] = []
    // 'a' registers a pending task and RETURNS: its evaluation is over, but
    // the agent it started is still running. Counting evaluations would free
    // the slot here; counting runs does not.
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
      if (item.id === 'a') pending.add('a')
    })
    await flush()

    emit([makeItem('a')])
    await flush()
    expect(dispatched).toEqual(['a'])

    emit([makeItem('b')])
    await flush()
    expect(dispatched).toEqual(['a']) // 'a' still running, cap is 1

    // The agent finishes — now the slot is genuinely free.
    pending.removePendingTask('a')
    emit([makeItem('b')])
    await flush()
    expect(dispatched.sort()).toEqual(['a', 'b'])

    disposable.dispose()
  }, 3000)

  test('items the gates reject never hold a slot, so a runnable item is not starved', async () => {
    // The regression this whole change exists for: issues blocked by
    // unfinished dependencies were dispatched, rejected by TaskDispatcher
    // without ever starting an agent, and still occupied every slot — so the
    // very issues they were blocked ON could never run, which never resolves.
    process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = '2'
    const { source, emit } = makeSource([])
    const pending = makePendingRegistry()
    const dispatcher = new SourceDispatcher('p1', source, () => {}, pending, 'webhook')
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
      // `blocked-*` mimics the blocker gate: returns without running an agent.
      if (item.id.startsWith('blocked-')) return
      pending.add(item.id)
    })
    await flush()

    emit([
      makeItem('blocked-1'),
      makeItem('blocked-2'),
      makeItem('blocked-3'),
      makeItem('blocked-4'),
      makeItem('runnable'),
    ])
    await flush()

    expect(dispatched).toContain('runnable')

    disposable.dispose()
  }, 3000)

  test('the evaluation guard defers a burst and retries it from the local buffer', async () => {
    // The run cap ignores evaluations by design, so this separate bound is
    // what keeps a large backlog from firing every source call at once.
    process.env.IA_FLOW_MAX_CONCURRENT_EVALUATIONS = '1'
    const { source, getItemsCalls, emit } = makeSource([])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
    )
    const dispatched: string[] = []
    const release: { current: (() => void) | null } = { current: null }
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
      if (item.id === 'a') {
        await new Promise<void>((resolve) => {
          release.current = resolve
        })
      }
    })
    await flush()
    const callsAfterBootScan = getItemsCalls() // boot scan always fires once

    emit([makeItem('a'), makeItem('b')])
    await flush()
    expect(dispatched).toEqual(['a']) // 'b' deferred: one evaluation in flight
    expect(getItemsCalls()).toBe(callsAfterBootScan) // deferring costs no source call

    release.current?.()
    await flush(1300)
    expect(dispatched.sort()).toEqual(['a', 'b'])
    expect(getItemsCalls()).toBe(callsAfterBootScan) // retried locally

    disposable.dispose()
  }, 3000)
})

describe('SourceDispatcher — mode: polling', () => {
  test('passes mode/projectId through to source.watch(), boot scan runs independent of the first tick', async () => {
    const captured: { opts: { mode: string; projectId: string } | null } = { opts: null }
    const source: ProjectSource = {
      kind: 'test',
      getStatuses: async () => [],
      getItems: async () => [],
      watch: (_onItems, opts) => {
        captured.opts = opts
        return { dispose: () => {} } as Disposable
      },
    }
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'polling',
    )
    const disposable = dispatcher.start(async () => {})
    await flush()
    expect(captured.opts).not.toBeNull()
    expect(captured.opts?.mode).toBe('polling')
    expect(captured.opts?.projectId).toBe('p1')
    disposable.dispose()
  })
})
