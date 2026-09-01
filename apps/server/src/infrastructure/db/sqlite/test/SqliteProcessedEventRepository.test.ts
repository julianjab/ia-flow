import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import type { EngineEvent } from '@ia-flow/shared'
import { SqliteProcessedEventRepository } from '../SqliteProcessedEventRepository.js'

// Mirrors migration 058 (Create rules, action_runs and processed_events tables).
function makeDb(): Database {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE processed_events (
      event_id     TEXT PRIMARY KEY NOT NULL,
      event_type   TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      expires_at   TEXT NOT NULL
    )
  `)
  return db
}

function makeEvent(id: string): EngineEvent {
  return {
    id,
    type: 'issues.unlabeled',
    source: 'github',
    scope: {},
    payload: {},
    depth: 0,
  } as EngineEvent
}

describe('SqliteProcessedEventRepository', () => {
  test('markProcessed: primera vez devuelve false, la segunda true', () => {
    const repo = new SqliteProcessedEventRepository(makeDb())
    const event = makeEvent('delivery-1:issues.unlabeled:3872')
    expect(repo.markProcessed(event)).toBe(false)
    expect(repo.markProcessed(event)).toBe(true)
  })

  test('remove: saca el id del dedupe — el mismo id se puede volver a marcar', () => {
    const repo = new SqliteProcessedEventRepository(makeDb())
    const event = makeEvent('delivery-1:issues.unlabeled:3872')
    repo.markProcessed(event)
    expect(repo.markProcessed(event)).toBe(true) // ya estaba

    expect(repo.remove(event.id)).toBe(true)

    expect(repo.markProcessed(event)).toBe(false) // libre de nuevo
  })

  test('remove: false cuando el id no estaba en el dedupe', () => {
    const repo = new SqliteProcessedEventRepository(makeDb())
    expect(repo.remove('nunca-visto')).toBe(false)
  })
})
