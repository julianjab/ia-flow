import { describe, expect, it } from 'bun:test'
import type { BoardCard } from './classify.js'
import { feedOf, pipelineOf } from './feed.js'

const card = (ref: string, patch: Partial<BoardCard> = {}): BoardCard => ({
  ref,
  projectId: 'p',
  title: ref,
  url: `https://github.com/${ref.replace('#', '/issues/')}`,
  status: 'Todo',
  labels: [],
  updatedAt: '2026-09-29T11:00:00Z',
  blockedBy: [],
  ...patch,
})

describe('pipelineOf', () => {
  it('reports running, queued and paused, with the global cap and what is left of it', () => {
    expect(pipelineOf({ running: 2, waiting: 3, paused: 1, max_concurrent: 4, free: 2 })).toEqual({
      running: 2,
      queued: 3,
      paused: 1,
      capacity: 4,
      free: 2,
    })
  })

  it('does not count paused runs as busy when it works out what is free', () => {
    expect(pipelineOf({ running: 1, waiting: 0, paused: 5, max_concurrent: 3 }).free).toBe(2)
  })

  it('omits capacity and free without a cap', () => {
    expect(pipelineOf({ running: 1, waiting: 0, paused: 0 })).toEqual({
      running: 1,
      queued: 0,
      paused: 0,
    })
  })
})

describe('feedOf', () => {
  it('splits the Todo cards into ready and waiting, in board order, saying who blocks them', () => {
    const cards = [
      card('o/r#1'),
      card('o/r#2', { blockedBy: ['o/r#9'] }),
      card('o/r#3', { status: 'Build' }),
      card('o/r#4'),
    ]
    const feed = feedOf(cards, 'Todo', () => false)
    expect(feed.ready.map((item) => item.ref)).toEqual(['o/r#1', 'o/r#4'])
    expect(feed.ready[0]?.blocked_by).toBeUndefined()
    expect(feed.waiting).toHaveLength(1)
    expect(feed.waiting[0]).toMatchObject({ ref: 'o/r#2', blocked_by: ['o/r#9'], status: 'Todo' })
  })

  it('leaves out the Todo cards that already started (running or queued)', () => {
    const feed = feedOf([card('o/r#1'), card('o/r#2')], 'Todo', (ref) => ref === 'o/r#1')
    expect(feed.ready.map((item) => item.ref)).toEqual(['o/r#2'])
  })

  it('reads the Todo column by its configured name', () => {
    const feed = feedOf([card('o/r#1', { status: 'Por hacer' })], 'Por hacer', () => false)
    expect(feed.ready).toHaveLength(1)
  })
})
