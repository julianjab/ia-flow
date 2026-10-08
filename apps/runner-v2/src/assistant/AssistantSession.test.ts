import { describe, expect, it } from 'bun:test'
import type { InboxItem } from '@ia-flow/shared'
import { type AssistantBackend, AssistantSession } from './AssistantSession.js'

const merge: InboxItem = {
  ref: 'o/r#1',
  project_id: 'p',
  title: 'Mergear',
  url: 'u',
  group: 'need',
  kind: 'merge',
  labels: [],
  why: 'Review + reviewed',
  since: '2026-09-29T10:00:00Z',
  unlocks: 2,
  epic: { ref: 'o/r#9', title: 'Bandeja', done: 1, total: 4 },
  priority: 1,
  reasons: ['a un merge de Done', 'destraba 2 tareas'],
  actions: ['merge'],
}

const backend = {
  inbox: { inbox: async () => ({ items: [merge] }) },
} as unknown as AssistantBackend

describe('AssistantSession.listTasks', () => {
  it('each task says its place in the order, why, and how much it unblocks', async () => {
    const session = new AssistantSession({ kind: 'general' }, backend, () => {})
    const [first] = await session.listTasks()
    expect(first).toMatchObject({
      ref: 'o/r#1',
      priority: 1,
      reasons: ['a un merge de Done', 'destraba 2 tareas'],
      unlocks: 2,
    })
  })

  it('each task says its epic and how far along it is', async () => {
    const session = new AssistantSession({ kind: 'general' }, backend, () => {})
    const [first] = await session.listTasks()
    expect(first?.epic).toEqual({ ref: 'o/r#9', title: 'Bandeja', done: 1, total: 4 })
  })
})
