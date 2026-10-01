import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { conversationTitle } from '../assistant/ConversationStore.js'
import { SqliteConversationStore } from './SqliteConversationStore.js'

const task = { kind: 'task', ref: 'o/r#1' } as const
const general = { kind: 'general' } as const

function storeAt(times: string[]) {
  let i = 0
  return new SqliteConversationStore(
    new Database(':memory:'),
    () => new Date(times[i++] ?? (times.at(-1) as string)),
  )
}

const exchange = (question: string, answer: string, tasks: string[] = []) => [
  { role: 'user' as const, content: question, proposals: [], tasks: [] },
  { role: 'assistant' as const, content: answer, proposals: [], tasks },
]

describe('SqliteConversationStore', () => {
  it('keeps each exchange in order, with its tasks, under its owner', () => {
    const store = storeAt(['2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z', '2026-09-30T10:05:00Z'])
    const id = store.create('julian', task, 'qué pasó')
    store.append(id, exchange('qué pasó', 'nada', ['o/r#1']))
    store.append(id, exchange('y ahora', 'mergeá'))
    const conversation = store.get(id, 'julian')
    expect(conversation).toMatchObject({ id, scope: task, title: 'qué pasó', messages: 4 })
    expect(conversation?.thread.map((m) => m.content)).toEqual([
      'qué pasó',
      'nada',
      'y ahora',
      'mergeá',
    ])
    expect(conversation?.thread[1]?.tasks).toEqual(['o/r#1'])
    expect(conversation?.updated_at).toBe('2026-09-30T10:05:00.000Z')
  })

  it('someone else cannot see, own or delete it', () => {
    const store = storeAt(['2026-09-30T10:00:00Z'])
    const id = store.create('julian', task, 'x')
    expect(store.owns(id, 'otra')).toBe(false)
    expect(store.get(id, 'otra')).toBeUndefined()
    expect(store.list('otra')).toEqual([])
    expect(store.remove(id, 'otra')).toBe(false)
    expect(store.remove(id, 'julian')).toBe(true)
    expect(store.get(id, 'julian')).toBeUndefined()
  })

  it('lists newest first, and by context when asked', () => {
    const store = storeAt(['2026-09-30T10:00:00Z', '2026-09-30T11:00:00Z'])
    const first = store.create('julian', task, 'tarea')
    const second = store.create('julian', general, 'general')
    expect(store.list('julian').map((c) => c.id)).toEqual([second, first])
    expect(store.list('julian', task).map((c) => c.id)).toEqual([first])
  })

  it('prune drops conversations untouched since the cutoff, with their messages', () => {
    const store = storeAt(['2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', '2026-09-30T00:00:00Z'])
    const old = store.create('julian', task, 'vieja')
    store.append(old, exchange('a', 'b'))
    const recent = store.create('julian', task, 'nueva')
    store.prune('2026-09-01T00:00:00Z')
    expect(store.list('julian').map((c) => c.id)).toEqual([recent])
  })

  it('a conversation is of one agent of the assistant', () => {
    const store = storeAt(['2026-09-30T10:00:00Z'])
    const id = store.create('julian', general, 'qué mejorar', 'assistant.runner-improvements')
    expect(store.owns(id, 'julian')).toBe(true)
    expect(store.owns(id, 'julian', 'assistant.runner-improvements')).toBe(true)
    expect(store.owns(id, 'julian', 'assistant')).toBe(false)
    expect(store.list('julian')).toMatchObject([{ id, agent: 'assistant.runner-improvements' }])
  })

  it('a database from before the agents keeps its conversations, as the default agent', () => {
    const database = new Database(':memory:')
    database.exec(`
      CREATE TABLE assistant_conversation (
        id TEXT PRIMARY KEY, github_login TEXT NOT NULL, scope_key TEXT NOT NULL,
        scope_json TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO assistant_conversation
        VALUES ('old', 'julian', 'general', '{"kind":"general"}', 'vieja', 'a', 'a');
    `)
    const store = new SqliteConversationStore(database)
    expect(store.list('julian')).toMatchObject([{ id: 'old', agent: 'assistant' }])
    expect(store.owns('old', 'julian', 'assistant')).toBe(true)
  })

  it('the title is the first question, on one line and short', () => {
    expect(conversationTitle('  ¿qué\n pasó?  ')).toBe('¿qué pasó?')
    expect(conversationTitle('x'.repeat(200))).toHaveLength(80)
  })
})
