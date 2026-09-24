import { describe, expect, it } from 'bun:test'
import { createEvent, type ExecutionLog, type ExecutionLogFilters } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../../../domain/ports/IExecutionLogRepository.js'
import { PrOutcomeHandler } from '../pr-outcome-handler.js'

function log(over: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'run-1',
    projectId: 'ia-flow',
    taskId: 'T123',
    taskTitle: 'Falta señal de resultado',
    agentId: 'builder',
    providerId: 'anthropic-api',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    outcome: 'success',
    errorMsg: null,
    stopReason: null,
    parentId: null,
    prNumber: null,
    prMerged: null,
    reviewRounds: null,
    ...over,
  } as ExecutionLog
}

/** Fake escrito a mano — no toca SQLite (criterio del repo). */
class FakeExecutionLogRepository implements IExecutionLogRepository {
  updates: Array<{ id: string; patch: Partial<ExecutionLog> }> = []

  constructor(private rows: ExecutionLog[]) {}

  insert(): void {}
  update(id: string, patch: Partial<ExecutionLog>): void {
    this.updates.push({ id, patch })
    const row = this.rows.find((r) => r.id === id)
    if (row) Object.assign(row, patch)
  }
  incrementReviewRounds(id: string): void {
    const row = this.rows.find((r) => r.id === id)
    const reviewRounds = (row?.reviewRounds ?? 0) + 1
    this.updates.push({ id, patch: { reviewRounds } })
    if (row) row.reviewRounds = reviewRounds
  }
  list(filters: ExecutionLogFilters): ExecutionLog[] {
    return this.rows.filter((r) => r.taskId === filters.taskId)
  }
  listActive(): ExecutionLog[] {
    return []
  }
  getById(id: string): ExecutionLog | null {
    return this.rows.find((r) => r.id === id) ?? null
  }
  sweepOrphaned(): ExecutionLog[] {
    return []
  }
  listDistinctSources(): string[] {
    return []
  }
  listLatestByTask() {
    return []
  }
  listLastOutputsByAgent() {
    return []
  }
}

function prEvent(
  type: 'pull_request' | 'pull_request_review',
  action: string,
  over: Record<string, unknown> = {},
) {
  return createEvent({
    type,
    source: 'github',
    scope: {},
    payload: { action, pr: { number: 7, head: { ref: 'task/T123' }, ...over } },
  })
}

describe('PrOutcomeHandler', () => {
  it('handles pull_request y pull_request_review, para cualquier action', () => {
    const handler = new PrOutcomeHandler(new FakeExecutionLogRepository([]))
    expect(handler.handles(prEvent('pull_request', 'closed'))).toBe(true)
    expect(handler.handles(prEvent('pull_request', 'opened'))).toBe(true)
    expect(handler.handles(prEvent('pull_request_review', 'submitted'))).toBe(true)
    expect(
      handler.handles(createEvent({ type: 'issues', source: 'github', scope: {}, payload: {} })),
    ).toBe(false)
  })

  it('marca pr_merged = true en el run que abrió el PR', async () => {
    const repo = new FakeExecutionLogRepository([log()])
    const handler = new PrOutcomeHandler(repo)
    const outcome = await handler.handle(prEvent('pull_request', 'closed', { merged: true }))
    expect(outcome).toBe('dispatched')
    expect(repo.getById('run-1')?.prMerged).toBe(true)
    expect(repo.getById('run-1')?.prNumber).toBe(7)
  })

  it('marca pr_merged = false en un PR cerrado sin merge', async () => {
    const repo = new FakeExecutionLogRepository([log()])
    const handler = new PrOutcomeHandler(repo)
    await handler.handle(prEvent('pull_request', 'closed', { merged: false }))
    expect(repo.getById('run-1')?.prMerged).toBe(false)
  })

  it('incrementa review_rounds en cada review submission', async () => {
    const repo = new FakeExecutionLogRepository([log({ reviewRounds: 1 })])
    const handler = new PrOutcomeHandler(repo)
    await handler.handle(prEvent('pull_request_review', 'submitted'))
    expect(repo.getById('run-1')?.reviewRounds).toBe(2)
  })

  it('se saltea cualquier otra action de estos dos eventos', async () => {
    const repo = new FakeExecutionLogRepository([log()])
    const handler = new PrOutcomeHandler(repo)
    expect(await handler.handle(prEvent('pull_request', 'opened'))).toBe('skipped')
    expect(await handler.handle(prEvent('pull_request', 'synchronize'))).toBe('skipped')
    expect(await handler.handle(prEvent('pull_request_review', 'edited'))).toBe('skipped')
    expect(await handler.handle(prEvent('pull_request_review', 'dismissed'))).toBe('skipped')
    expect(repo.updates.length).toBe(0)
  })

  it('salta sub-agentes y atribuye al último run de agente propio', async () => {
    const repo = new FakeExecutionLogRepository([
      log({ id: 'sub-1', parentId: 'run-1', startedAt: '2026-01-01T00:10:00.000Z' }),
      log({ id: 'run-1' }),
    ])
    const handler = new PrOutcomeHandler(repo)
    await handler.handle(prEvent('pull_request', 'closed', { merged: true }))
    expect(repo.getById('run-1')?.prMerged).toBe(true)
    expect(repo.getById('sub-1')?.prMerged).toBe(null)
  })

  it('se saltea (best-effort) cuando el branch no sigue la convención task/<id>', async () => {
    const repo = new FakeExecutionLogRepository([log()])
    const handler = new PrOutcomeHandler(repo)
    const outcome = await handler.handle(
      prEvent('pull_request', 'closed', { merged: true, head: { ref: 'feature/manual-branch' } }),
    )
    expect(outcome).toBe('skipped')
    expect(repo.updates.length).toBe(0)
  })

  it('se saltea cuando la task no tiene ningún run de agente', async () => {
    const repo = new FakeExecutionLogRepository([])
    const handler = new PrOutcomeHandler(repo)
    const outcome = await handler.handle(prEvent('pull_request', 'closed', { merged: true }))
    expect(outcome).toBe('skipped')
  })
})
