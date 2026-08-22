import { beforeEach, describe, expect, test } from 'bun:test'
import type { ExecutionLog, ExecutionLogFilters } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../../../domain/ports/IExecutionLogRepository.js'
import { CompositeExecutionLogRepository } from '../CompositeExecutionLogRepository.js'

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
    ...overrides,
  }
}

class FakeRepo implements IExecutionLogRepository {
  inserted: ExecutionLog[] = []
  updated: Array<{ id: string; patch: Partial<ExecutionLog> }> = []
  throwOnInsert = false
  throwOnUpdate = false

  insert(entry: ExecutionLog): void {
    if (this.throwOnInsert) throw new Error('insert failed')
    this.inserted.push(entry)
  }
  update(id: string, patch: Partial<ExecutionLog>): void {
    if (this.throwOnUpdate) throw new Error('update failed')
    this.updated.push({ id, patch })
  }
  list(_filters: ExecutionLogFilters): ExecutionLog[] {
    return this.inserted
  }
  listActive(): ExecutionLog[] {
    return this.inserted.filter((e) => e.finishedAt === null)
  }
  getById(id: string): ExecutionLog | null {
    return this.inserted.find((e) => e.id === id) ?? null
  }
  swept: ExecutionLog[] = []
  sweepOrphaned(_reason: string): ExecutionLog[] {
    return this.swept
  }
  listDistinctSources(): string[] {
    return []
  }
}

describe('CompositeExecutionLogRepository', () => {
  let primary: FakeRepo
  let secondary: FakeRepo

  beforeEach(() => {
    primary = new FakeRepo()
    secondary = new FakeRepo()
  })

  test('throws when constructed with no repos', () => {
    expect(() => new CompositeExecutionLogRepository([])).toThrow()
  })

  test('insert fans out to every composed repo', () => {
    const composite = new CompositeExecutionLogRepository([primary, secondary])
    const entry = fakeEntry()
    composite.insert(entry)
    expect(primary.inserted).toEqual([entry])
    expect(secondary.inserted).toEqual([entry])
  })

  test('update fans out to every composed repo', () => {
    const composite = new CompositeExecutionLogRepository([primary, secondary])
    composite.update('exec-1', { outcome: 'success' })
    expect(primary.updated).toEqual([{ id: 'exec-1', patch: { outcome: 'success' } }])
    expect(secondary.updated).toEqual([{ id: 'exec-1', patch: { outcome: 'success' } }])
  })

  test('a failing secondary repo does not stop the primary write (local fallback)', () => {
    secondary.throwOnInsert = true
    const composite = new CompositeExecutionLogRepository([primary, secondary])
    const entry = fakeEntry()
    expect(() => composite.insert(entry)).not.toThrow()
    expect(primary.inserted).toEqual([entry])
    expect(secondary.inserted).toEqual([])
  })

  test('a failing primary repo does not stop a secondary write', () => {
    primary.throwOnUpdate = true
    const composite = new CompositeExecutionLogRepository([primary, secondary])
    expect(() => composite.update('exec-1', { outcome: 'error' })).not.toThrow()
    expect(primary.updated).toEqual([])
    expect(secondary.updated).toEqual([{ id: 'exec-1', patch: { outcome: 'error' } }])
  })

  test('reads (list/listActive/getById/sweepOrphaned/listDistinctSources) delegate to the primary only', () => {
    const entry = fakeEntry()
    primary.inserted.push(entry)
    const composite = new CompositeExecutionLogRepository([primary, secondary])
    expect(composite.list({})).toEqual([entry])
    expect(composite.listActive()).toEqual([entry])
    expect(composite.getById('exec-1')).toEqual(entry)
    expect(composite.sweepOrphaned('boot')).toEqual([])
    expect(composite.listDistinctSources()).toEqual([])
  })

  // Regression: the sweep is a bulk UPDATE inside the primary, invisible to
  // the write-only mirrors. Without the replay, a headless container that
  // restarts closes its rows locally while the main daemon renders them as
  // running forever — it may not close a foreign-`source` row itself.
  test('sweepOrphaned replays each closed row onto the mirrors', () => {
    primary.swept = [
      fakeEntry({
        id: 'exec-1',
        finishedAt: '2026-01-01T00:05:00.000Z',
        outcome: 'error',
        errorMsg: 'orphaned: server restart before finalize',
      }),
    ]
    const composite = new CompositeExecutionLogRepository([primary, secondary])

    const closed = composite.sweepOrphaned('orphaned: server restart before finalize')

    expect(closed.map((r) => r.id)).toEqual(['exec-1'])
    expect(secondary.updated).toEqual([
      {
        id: 'exec-1',
        patch: {
          finishedAt: '2026-01-01T00:05:00.000Z',
          outcome: 'error',
          errorMsg: 'orphaned: server restart before finalize',
        },
      },
    ])
    // The primary already applied it in SQL — no double write.
    expect(primary.updated).toEqual([])
  })

  test('a mirror that throws during the sweep replay does not break the sweep', () => {
    secondary.throwOnUpdate = true
    primary.swept = [fakeEntry({ id: 'exec-1', finishedAt: '2026-01-01T00:05:00.000Z' })]
    const composite = new CompositeExecutionLogRepository([primary, secondary])
    expect(() => composite.sweepOrphaned('boot')).not.toThrow()
  })
})
