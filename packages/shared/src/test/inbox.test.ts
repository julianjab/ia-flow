import { describe, expect, it } from 'bun:test'
import { InboxItemSchema, InboxSchema } from '../inbox.js'
import { TaskFactSchema } from '../tasks.js'

const base = { generated_at: '2026-10-06T00:00:00Z', projects: [], items: [] }

describe('InboxSchema', () => {
  it('accepts an inbox from an old runner, without pipeline or feed', () => {
    const inbox = InboxSchema.parse(base)
    expect(inbox.pipeline).toBeUndefined()
    expect(inbox.feed).toBeUndefined()
  })

  it('reads the pipeline occupancy and the Todo feed', () => {
    const item = {
      ref: 'o/r#2',
      project_id: 'p',
      title: 't',
      url: 'u',
      labels: [],
      updated_at: '2026-10-06T00:00:00Z',
    }
    const inbox = InboxSchema.parse({
      ...base,
      pipeline: { running: 1, queued: 2, paused: 0 },
      feed: { ready: [item], waiting: [{ ...item, ref: 'o/r#3', blocked_by: ['o/r#2'] }] },
    })
    expect(inbox.pipeline?.capacity).toBeUndefined()
    expect(inbox.feed?.waiting[0]?.blocked_by).toEqual(['o/r#2'])
  })
})

describe('epic', () => {
  const epic = { ref: 'o/r#9', title: 'Bandeja', done: 2, total: 5 }
  const item = {
    ref: 'o/r#1',
    project_id: 'p',
    title: 't',
    url: 'u',
    group: 'need',
    kind: 'merge',
    labels: [],
    why: 'w',
    since: '',
    actions: [],
  }
  const fact = {
    ref: 'o/r#1',
    project_id: 'p',
    title: 't',
    url: 'u',
    updated_at: '2026-10-06T00:00:00Z',
    blocked_by_refs: [],
    actions: [],
    action_defs: [],
    item: { type: 'technical', repos: ['r'], labels: [], blocked: false },
    run: {},
    live: {},
    queue: { waiting: false },
    task: { idle_hours: 0, waiting_hours: 0, unlocks: 0, blocked_by: 0 },
  }

  it('an inbox item and a task fact carry their epic with its progress', () => {
    expect(InboxItemSchema.parse({ ...item, epic }).epic).toEqual(epic)
    expect(TaskFactSchema.parse({ ...fact, epic }).epic).toEqual(epic)
  })

  it('is optional: an old runner (or a task without a parent) does not send it', () => {
    expect(InboxItemSchema.parse(item).epic).toBeUndefined()
    expect(TaskFactSchema.parse(fact).epic).toBeUndefined()
  })
})
