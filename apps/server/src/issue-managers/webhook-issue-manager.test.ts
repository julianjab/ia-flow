import { describe, expect, test } from 'bun:test'
import type { IStatusRepository } from '../domain/ports/IStatusRepository.js'
import type { ProjectSource, SourceItem } from '../project-sources/types.js'
import type { IssueItem } from './types.js'
import { WebhookIssueManager } from './webhook-issue-manager.js'
import { deliverWebhook, listWebhookTargets } from './webhook-registry.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeStatusRepo(names: string[]): IStatusRepository {
  return {
    list: () => names.map((name, i) => ({ id: `s${i}`, projectId: 'p1', name, order: i })),
  } as unknown as IStatusRepository
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
  test('scans on startup and dispatches matching items', async () => {
    const dispatched: IssueItem[] = []
    const mgr = new WebhookIssueManager(
      'p1',
      fakeSource([item('i1', 'Todo'), item('i2', 'Done')]),
      () => {},
      fakeStatusRepo(['Todo']),
      0, // no debounce
      0, // no fallback interval
    )

    const sub = mgr.start(async (i) => {
      dispatched.push(i)
    })
    await sleep(20)

    expect(dispatched.map((d) => d.id)).toEqual(['i1'])
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
      fakeStatusRepo(['Todo']),
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
      fakeStatusRepo(['Todo']),
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
      fakeStatusRepo(['Todo']),
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

  test('fallback stays fast until the first delivery, then relaxes', async () => {
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
      fakeStatusRepo(['Todo']),
      0,
      10_000, // slow fallback; ticks run at min(fallback, pollInterval)
    )
    const sub = mgr.start(async () => {})
    await sleep(20)
    expect(scans).toBe(1) // startup

    // No delivery yet → every fallback tick is due (hook may never have been
    // configured; we can't tell that from a quiet board).
    mgr.trigger('fallback')
    await sleep(20)
    expect(scans).toBe(2)

    // A real delivery flips the manager into the relaxed regime...
    await deliverWebhook({ event: 'projects_v2_item' })
    await sleep(20)
    expect(scans).toBe(3)

    // ...so a fallback tick right after a scan is no longer due.
    mgr.trigger('fallback')
    await sleep(20)
    expect(scans).toBe(3)
    expect(mgr.stats().deliveryReceived).toBe(true)
    sub.dispose()
  })

  test('matches() delegates to the source, and matches everything without it', async () => {
    const withMatcher = new WebhookIssueManager(
      'p1',
      fakeSource([], { matchesWebhook: async (h) => h.projectNodeId === 'PVT_1' }),
      () => {},
      fakeStatusRepo([]),
      0,
      0,
    )
    expect(await withMatcher.matches({ projectNodeId: 'PVT_1' })).toBe(true)
    expect(await withMatcher.matches({ projectNodeId: 'PVT_2' })).toBe(false)

    const without = new WebhookIssueManager(
      'p2',
      fakeSource([]),
      () => {},
      fakeStatusRepo([]),
      0,
      0,
    )
    expect(await without.matches({ projectNodeId: 'anything' })).toBe(true)
  })
})
