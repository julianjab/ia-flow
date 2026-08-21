import { describe, expect, test } from 'bun:test'
import type { ExecutionLog, ExecutionLogFilters } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../../../domain/ports/IExecutionLogRepository.js'
import { SourceTaggingExecutionLogRepository } from '../SourceTaggingExecutionLogRepository.js'

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
  insert(entry: ExecutionLog): void {
    this.inserted.push(entry)
  }
  update(id: string, patch: Partial<ExecutionLog>): void {
    this.updated.push({ id, patch })
  }
  list(_filters: ExecutionLogFilters): ExecutionLog[] {
    return this.inserted
  }
  listActive(): ExecutionLog[] {
    return this.inserted
  }
  getById(id: string): ExecutionLog | null {
    return this.inserted.find((e) => e.id === id) ?? null
  }
  sweepOrphaned(_reason: string): number {
    return 0
  }
  listDistinctSources(): string[] {
    return ['tagged-source']
  }
}

describe('SourceTaggingExecutionLogRepository', () => {
  test('stamps this.source onto an entry with no source of its own', () => {
    const inner = new FakeRepo()
    const repo = new SourceTaggingExecutionLogRepository(inner, 'subscriptions-pipeline')
    repo.insert(fakeEntry())
    expect(inner.inserted[0].source).toBe('subscriptions-pipeline')
  })

  test('never overwrites a source the entry already carries', () => {
    const inner = new FakeRepo()
    const repo = new SourceTaggingExecutionLogRepository(inner, 'subscriptions-pipeline')
    repo.insert(fakeEntry({ source: 'explicit-source' }))
    expect(inner.inserted[0].source).toBe('explicit-source')
  })

  test('update passes the patch through untouched — no source stamping on update', () => {
    const inner = new FakeRepo()
    const repo = new SourceTaggingExecutionLogRepository(inner, 'subscriptions-pipeline')
    repo.update('exec-1', { outcome: 'success' })
    expect(inner.updated).toEqual([{ id: 'exec-1', patch: { outcome: 'success' } }])
  })

  test('delegates every read method to the inner repo', () => {
    const inner = new FakeRepo()
    inner.inserted.push(fakeEntry())
    const repo = new SourceTaggingExecutionLogRepository(inner, 'subscriptions-pipeline')
    expect(repo.list({})).toEqual(inner.inserted)
    expect(repo.listActive()).toEqual(inner.inserted)
    expect(repo.getById('exec-1')).toEqual(inner.inserted[0])
    expect(repo.sweepOrphaned('boot')).toBe(0)
    expect(repo.listDistinctSources()).toEqual(['tagged-source'])
  })
})
