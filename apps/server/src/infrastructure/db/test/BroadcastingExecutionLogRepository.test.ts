import { describe, expect, test } from 'bun:test'
import type { ExecutionLog, ExecutionLogFilters } from '@ia-flow/shared'
import type { IBroadcast } from '../../../domain/ports/IBroadcast.js'
import type { IExecutionLogRepository } from '../../../domain/ports/IExecutionLogRepository.js'
import { BroadcastingExecutionLogRepository } from '../BroadcastingExecutionLogRepository.js'

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
  rows = new Map<string, ExecutionLog>()
  insert(entry: ExecutionLog): void {
    this.rows.set(entry.id, entry)
  }
  update(id: string, patch: Partial<ExecutionLog>): void {
    const existing = this.rows.get(id)
    if (existing) this.rows.set(id, { ...existing, ...patch })
  }
  list(_filters: ExecutionLogFilters): ExecutionLog[] {
    return Array.from(this.rows.values())
  }
  listActive(): ExecutionLog[] {
    return Array.from(this.rows.values()).filter((e) => e.finishedAt === null)
  }
  getById(id: string): ExecutionLog | null {
    return this.rows.get(id) ?? null
  }
  sweepOrphaned(_reason: string): ExecutionLog[] {
    // El port devuelve las filas que cerró, no cuántas: los decoradores las
    // necesitan para espejar y para emitir por WS.
    return []
  }
  listDistinctSources(): string[] {
    return ['subscriptions-pipeline']
  }
  listLatestByTask(): [] {
    return []
  }
  listLastOutputsByAgent(): Array<{ agentId: string; structuredOutput: Record<string, unknown> }> {
    return []
  }
}

class FakeBroadcast implements IBroadcast {
  sent: object[] = []
  send(msg: object): void {
    this.sent.push(msg)
  }
}

describe('BroadcastingExecutionLogRepository', () => {
  test('insert delegates to the inner repo, then broadcasts execution:started with the fresh row', () => {
    const inner = new FakeRepo()
    const broadcast = new FakeBroadcast()
    const repo = new BroadcastingExecutionLogRepository(inner, broadcast)
    const entry = fakeEntry()

    repo.insert(entry)

    expect(inner.getById('exec-1')).toEqual(entry)
    expect(broadcast.sent).toEqual([{ type: 'execution:started', log: entry }])
  })

  test('update delegates, then broadcasts execution:updated with the fresh row', () => {
    const inner = new FakeRepo()
    inner.insert(fakeEntry())
    const broadcast = new FakeBroadcast()
    const repo = new BroadcastingExecutionLogRepository(inner, broadcast)

    repo.update('exec-1', { outcome: 'success' })

    expect(inner.getById('exec-1')?.outcome).toBe('success')
    expect(broadcast.sent).toEqual([
      { type: 'execution:updated', log: { ...fakeEntry(), outcome: 'success' } },
    ])
  })

  test('update on a nonexistent id does not broadcast', () => {
    const inner = new FakeRepo()
    const broadcast = new FakeBroadcast()
    const repo = new BroadcastingExecutionLogRepository(inner, broadcast)

    repo.update('ghost', { outcome: 'success' })

    expect(broadcast.sent).toEqual([])
  })

  test('list/listActive/getById/listDistinctSources delegate without broadcasting', () => {
    const inner = new FakeRepo()
    inner.insert(fakeEntry())
    const broadcast = new FakeBroadcast()
    const repo = new BroadcastingExecutionLogRepository(inner, broadcast)

    expect(repo.list({})).toEqual(inner.list({}))
    expect(repo.listActive()).toEqual(inner.listActive())
    expect(repo.getById('exec-1')).toEqual(inner.getById('exec-1'))
    expect(repo.listDistinctSources()).toEqual(['subscriptions-pipeline'])
    expect(broadcast.sent).toEqual([])
  })

  test('sweepOrphaned delegates without broadcasting per-row (boot-time cleanup)', () => {
    const inner = new FakeRepo()
    const broadcast = new FakeBroadcast()
    const repo = new BroadcastingExecutionLogRepository(inner, broadcast)

    expect(repo.sweepOrphaned('boot')).toEqual([])
    expect(broadcast.sent).toEqual([])
  })
})
