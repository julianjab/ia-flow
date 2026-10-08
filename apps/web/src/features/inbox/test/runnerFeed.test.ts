import type { InboxFeed } from '@ia-flow/shared'
import { describe, expect, it } from 'vitest'
import { buildQueue } from '@/features/inbox/queue/build'
import {
  blockedOf,
  capacityOf,
  isQueuedRun,
  pickFeed,
  RUNNER_FEED_TITLE,
  runnerFeed,
} from '@/features/inbox/queue/runnerFeed'
import { item } from '@/features/inbox/test/fixtures'

const NOW = Date.parse('2026-01-02T10:00:00.000Z')

const card = (n: number, blocked_by?: string[]) => ({
  ref: `la-haus/subscriptions#${n}`,
  project_id: 'p',
  title: `Card ${n}`,
  url: `https://github.com/la-haus/subscriptions/issues/${n}`,
  status: 'Todo',
  labels: [],
  updated_at: '2026-01-01T10:00:00Z',
  ...(blocked_by ? { blocked_by } : {}),
})
const feed: InboxFeed = {
  ready: [card(1), card(2)],
  waiting: [card(3, ['la-haus/subscriptions#1579'])],
}
const pipeline = { running: 1, queued: 2, paused: 0, capacity: 5, free: 4 }

describe('el feed y el pipeline del runner', () => {
  it('runnerFeed: primero las listas, después las que esperan, con a quién', () => {
    const f = runnerFeed(feed)
    expect(f?.title).toBe(RUNNER_FEED_TITLE)
    expect(f?.entries.map((e) => [e.ref, e.waitingOn?.short])).toEqual([
      ['la-haus/subscriptions#1', undefined],
      ['la-haus/subscriptions#2', undefined],
      ['la-haus/subscriptions#3', 'subs#1579'],
    ])
    expect(f?.entries[2]?.waitingOn?.url).toBe(
      'https://github.com/la-haus/subscriptions/issues/1579',
    )
    expect(runnerFeed(undefined)).toBeNull()
  })

  it('pickFeed: el del dashboard manda; sin él, el del runner', () => {
    const own = { title: 'Mío', entries: [] }
    expect(pickFeed(own, feed)).toBe(own)
    expect(pickFeed(null, feed)?.entries).toHaveLength(3)
  })

  it('capacityOf traduce el pipeline del runner a la capacidad de /api/tasks', () => {
    expect(capacityOf(pipeline)).toEqual({
      running: 1,
      waiting: 2,
      paused: 0,
      max_concurrent: 5,
      free: 4,
    })
    expect(capacityOf(undefined)).toBeNull()
  })
})

describe('en cola vs. esperan a otra tarea', () => {
  const dep = (n: number, blocker: string) =>
    item({
      ref: `la-haus/subscriptions#${n}`,
      title: `Dep ${n}`,
      group: 'queue',
      kind: 'dep',
      blocked_by: [blocker],
    })
  const turn = item({ ref: 'acme/api#5', title: 'Turno', group: 'queue', kind: 'turn' })

  it('una tarjeta dep no es una ejecución en cola', () => {
    expect(isQueuedRun(dep(1, 'a/b#1'))).toBe(false)
    expect(isQueuedRun(turn)).toBe(true)
  })

  it('blockedOf: cada una con su primer bloqueante, en link corto', () => {
    expect(blockedOf([turn, dep(1580, 'la-haus/subscriptions#1579')])).toEqual([
      {
        ref: 'la-haus/subscriptions#1580',
        short: 'subs#1580',
        url: 'https://github.com/acme/api/issues/7',
        title: 'Dep 1580',
        waitingOn: {
          short: 'subs#1579',
          url: 'https://github.com/la-haus/subscriptions/issues/1579',
        },
      },
    ])
  })

  it('con los datos del :3011 — 0 en cola y 3 dep — el número y la lista dicen lo mismo', () => {
    const q = buildQueue({
      now: NOW,
      items: [dep(1580, 'la-haus/subscriptions#1579'), dep(1776, 'la-haus/subscriptions#1775')],
      capacity: { running: 0, waiting: 0, paused: 0, max_concurrent: 5, free: 5 },
    })
    expect(q.pipeline.waiting).toBe(0)
    expect(q.queued).toEqual([])
    expect(q.blocked.map((b) => b.short)).toEqual(['subs#1580', 'subs#1776'])
  })

  it('sin capacidad, «en cola» cuenta sólo las que esperan turno', () => {
    const q = buildQueue({ now: NOW, items: [turn, dep(1, 'a/b#1')] })
    expect(q.pipeline).toMatchObject({ waiting: 1, source: 'items' })
    expect(q.queued.map((r) => r.ref)).toEqual([turn.ref])
  })
})

describe('buildQueue con lo que manda el runner', () => {
  it('sin panel de feed en el dashboard, el feed es el del runner (con las que esperan)', () => {
    const q = buildQueue({ now: NOW, items: [], runner: { feed, pipeline } })
    expect(q.feed?.title).toBe(RUNNER_FEED_TITLE)
    expect(q.feed?.entries.map((e) => [e.short, e.waitingOn?.short])).toEqual([
      ['subs#1', undefined],
      ['subs#2', undefined],
      ['subs#3', 'subs#1579'],
    ])
    // Sin capacidad del dashboard, la del runner: lugares libres en el feed y en el pipeline.
    expect(q.feed?.free).toBe(4)
    expect(q.pipeline).toEqual({ running: 1, waiting: 2, free: 4, max: 5, source: 'capacity' })
  })

  it('el panel del dashboard y su capacidad mandan sobre los del runner', () => {
    const q = buildQueue({
      now: NOW,
      items: [],
      feed: { title: 'Mío', entries: [] },
      capacity: { running: 0, waiting: 0, paused: 0, max_concurrent: 2, free: 2 },
      runner: { feed, pipeline },
    })
    expect(q.feed).toMatchObject({ title: 'Mío', free: 2, entries: [] })
    expect(q.pipeline.max).toBe(2)
  })
})
