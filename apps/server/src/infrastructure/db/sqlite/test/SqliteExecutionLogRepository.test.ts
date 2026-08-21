import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ExecutionLog } from '@ia-flow/shared'
import { SqliteExecutionLogRepository } from '../SqliteExecutionLogRepository.js'

// Mirrors migrations 021 (base table) + 023 (session_kind/session_id) + 040
// (source) — the columns SqliteExecutionLogRepository actually reads/writes.
function setup(): SqliteExecutionLogRepository {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE execution_logs (
    id          TEXT PRIMARY KEY NOT NULL,
    project_id  TEXT NOT NULL,
    task_id     TEXT NOT NULL,
    task_title  TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    outcome     TEXT,
    error_msg   TEXT,
    stop_reason TEXT,
    session_kind TEXT,
    session_id   TEXT,
    source       TEXT
  )`)
  return new SqliteExecutionLogRepository(db)
}

function fakeEntry(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'exec-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    taskTitle: 'Title',
    agentId: 'agent-1',
    providerId: 'provider-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    outcome: null,
    errorMsg: null,
    stopReason: null,
    sessionKind: null,
    sessionId: null,
    source: null,
    ...overrides,
  }
}

describe('SqliteExecutionLogRepository', () => {
  let repo: SqliteExecutionLogRepository

  beforeEach(() => {
    repo = setup()
  })

  test('insert + getById round-trips every field, including null source', () => {
    repo.insert(fakeEntry())
    expect(repo.getById('exec-1')).toEqual(fakeEntry())
  })

  test('insert persists a non-null source', () => {
    repo.insert(fakeEntry({ source: 'subscriptions-pipeline' }))
    expect(repo.getById('exec-1')?.source).toBe('subscriptions-pipeline')
  })

  test('getById returns null for a missing row', () => {
    expect(repo.getById('nope')).toBeNull()
  })

  test('update patches only the given fields', () => {
    repo.insert(fakeEntry())
    repo.update('exec-1', { outcome: 'success', finishedAt: '2026-01-01T00:05:00.000Z' })
    const row = repo.getById('exec-1')
    expect(row?.outcome).toBe('success')
    expect(row?.finishedAt).toBe('2026-01-01T00:05:00.000Z')
    expect(row?.taskTitle).toBe('Title')
  })

  test('update is a no-op when the patch is empty', () => {
    repo.insert(fakeEntry())
    repo.update('exec-1', {})
    expect(repo.getById('exec-1')).toEqual(fakeEntry())
  })

  test('list with no filters returns every row, newest first', () => {
    repo.insert(fakeEntry({ id: 'a', startedAt: '2026-01-01T00:00:00.000Z' }))
    repo.insert(fakeEntry({ id: 'b', startedAt: '2026-01-02T00:00:00.000Z' }))
    const rows = repo.list({})
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
  })

  test('list filters by taskId', () => {
    repo.insert(fakeEntry({ id: 'a', taskId: 't1' }))
    repo.insert(fakeEntry({ id: 'b', taskId: 't2' }))
    expect(repo.list({ taskId: 't1' }).map((r) => r.id)).toEqual(['a'])
  })

  test('list filters by a single-value or array projectId/agentId/providerId/outcome/source', () => {
    repo.insert(fakeEntry({ id: 'a', source: 'subscriptions-pipeline' }))
    repo.insert(fakeEntry({ id: 'b', source: 'functional-refiner' }))
    repo.insert(fakeEntry({ id: 'c', source: null }))

    expect(repo.list({ source: 'subscriptions-pipeline' }).map((r) => r.id)).toEqual(['a'])
    expect(
      new Set(
        repo.list({ source: ['subscriptions-pipeline', 'functional-refiner'] }).map((r) => r.id),
      ),
    ).toEqual(new Set(['a', 'b']))
  })

  test('list respects from/to and limit', () => {
    repo.insert(fakeEntry({ id: 'a', startedAt: '2026-01-01T00:00:00.000Z' }))
    repo.insert(fakeEntry({ id: 'b', startedAt: '2026-01-02T00:00:00.000Z' }))
    repo.insert(fakeEntry({ id: 'c', startedAt: '2026-01-03T00:00:00.000Z' }))
    expect(
      repo
        .list({ from: '2026-01-02T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z' })
        .map((r) => r.id),
    ).toEqual(['c', 'b'])
    expect(repo.list({ limit: 1 }).map((r) => r.id)).toEqual(['c'])
  })

  test('listActive returns only rows with finishedAt = null', () => {
    repo.insert(fakeEntry({ id: 'a', finishedAt: null }))
    repo.insert(fakeEntry({ id: 'b', finishedAt: '2026-01-01T00:05:00.000Z' }))
    expect(repo.listActive().map((r) => r.id)).toEqual(['a'])
  })

  test('sweepOrphaned closes every open row and returns the count', () => {
    repo.insert(fakeEntry({ id: 'a', finishedAt: null }))
    repo.insert(fakeEntry({ id: 'b', finishedAt: '2026-01-01T00:05:00.000Z' }))
    const changed = repo.sweepOrphaned('server restart')
    expect(changed).toBe(1)
    const row = repo.getById('a')
    expect(row?.outcome).toBe('error')
    expect(row?.errorMsg).toBe('server restart')
    expect(row?.finishedAt).not.toBeNull()
    // Already-finished rows are left untouched.
    expect(repo.getById('b')?.errorMsg).toBeNull()
  })

  test('listDistinctSources returns sorted non-null sources only', () => {
    repo.insert(fakeEntry({ id: 'a', source: 'functional-refiner' }))
    repo.insert(fakeEntry({ id: 'b', source: 'subscriptions-pipeline' }))
    repo.insert(fakeEntry({ id: 'c', source: null }))
    expect(repo.listDistinctSources()).toEqual(['functional-refiner', 'subscriptions-pipeline'])
  })
})
