import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ExecutionLog } from '@ia-flow/shared'

// executions.ts imports executionLogRepo from composition/container.js
// (service locator) and getPendingTask/removePendingTask from
// @ia-flow/agent-engine directly — mock.module both BEFORE importing the
// route so this test never opens a real SQLite connection or touches the
// real pending-task registry. Same rationale as agents-crud.test.ts
// avoiding container.js: it opens a real DB connection as an import side
// effect. No other test file in this repo mocks these two modules, so
// there's no cross-file leakage to worry about.
const rows = new Map<string, ExecutionLog>()

function seed(execs: ExecutionLog[]) {
  rows.clear()
  for (const e of execs) rows.set(e.id, e)
}

const fakeRepo = {
  listDistinctSources: mock(() => ['subscriptions-pipeline']),
  list: mock(() => Array.from(rows.values())),
  listActive: mock(() => Array.from(rows.values()).filter((r) => !r.finishedAt)),
  getById: mock((id: string) => rows.get(id) ?? null),
  update: mock((id: string, patch: Partial<ExecutionLog>) => {
    const existing = rows.get(id)
    if (!existing) return
    rows.set(id, { ...existing, ...patch })
  }),
  insert: mock(() => {}),
  sweepOrphaned: mock(() => 0),
}

let pendingTask: { cancel?: () => Promise<void> } | undefined
const getPendingTaskMock = mock(() => pendingTask)
const removePendingTaskMock = mock(() => {})

mock.module('../../composition/container.js', () => ({ executionLogRepo: fakeRepo }))
mock.module('@ia-flow/agent-engine', () => ({
  getPendingTask: getPendingTaskMock,
  removePendingTask: removePendingTaskMock,
}))

const { createExecutionsRouter } = await import('../executions.js')

function makeExec(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'e1',
    projectId: 'p1',
    taskId: 't1',
    taskTitle: 'Title',
    agentId: 'agent-1',
    providerId: 'anthropic-api',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    outcome: null,
    errorMsg: null,
    stopReason: null,
    ...overrides,
  }
}

describe('executions router', () => {
  const app = createExecutionsRouter()

  beforeEach(() => {
    seed([])
    pendingTask = undefined
    getPendingTaskMock.mockClear()
    removePendingTaskMock.mockClear()
    fakeRepo.update.mockClear()
  })

  test('GET /sources returns distinct sources', async () => {
    const res = await app.request('/sources')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sources: ['subscriptions-pipeline'] })
  })

  test('GET / lists executions and accepts repeated multi-select filters', async () => {
    seed([makeExec({ id: 'e1' }), makeExec({ id: 'e2' })])
    const res = await app.request('/?agentId=agent-1&agentId=agent-2&limit=5')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { executions: ExecutionLog[] }
    expect(body.executions.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  test('GET / rejects invalid filter values with 400', async () => {
    const res = await app.request('/?outcome=not-a-real-outcome')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Invalid query params')
  })

  test('GET /active returns only unfinished rows', async () => {
    seed([
      makeExec({ id: 'running', finishedAt: null }),
      makeExec({ id: 'done', finishedAt: '2026-01-01T00:10:00.000Z', outcome: 'success' }),
    ])
    const res = await app.request('/active')
    const body = (await res.json()) as { executions: ExecutionLog[] }
    expect(body.executions.map((e) => e.id)).toEqual(['running'])
  })

  test('GET /:id returns the execution', async () => {
    seed([makeExec({ id: 'e1' })])
    const res = await app.request('/e1')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { execution: ExecutionLog }).execution.id).toBe('e1')
  })

  test('GET /:id returns 404 when missing', async () => {
    const res = await app.request('/missing')
    expect(res.status).toBe(404)
  })

  describe('POST /:id/cancel', () => {
    test('404 when the execution does not exist', async () => {
      const res = await app.request('/missing/cancel', { method: 'POST' })
      expect(res.status).toBe(404)
    })

    test('no-op when already finished', async () => {
      seed([makeExec({ id: 'e1', finishedAt: '2026-01-01T00:05:00.000Z', outcome: 'success' })])
      const res = await app.request('/e1/cancel', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; alreadyFinished?: boolean }
      expect(body).toMatchObject({ ok: true, alreadyFinished: true })
    })

    test('marks cancelRequestedAt (advisory only) instead of cancelling when source is set', async () => {
      seed([makeExec({ id: 'e1', source: 'subscriptions-pipeline' })])
      const res = await app.request('/e1/cancel', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        cancelRequested?: boolean
        execution: ExecutionLog
      }
      expect(body.ok).toBe(true)
      expect(body.cancelRequested).toBe(true)
      expect(body.execution.cancelRequestedAt).toEqual(expect.any(String))
      // The row stays open — this never claims the remote run actually stopped.
      expect(body.execution.finishedAt).toBeNull()
      expect(fakeRepo.update).toHaveBeenCalledWith(
        'e1',
        expect.objectContaining({ cancelRequestedAt: expect.any(String) }),
      )
      // No pending-task plumbing touched — this daemon never had one for a remote row.
      expect(getPendingTaskMock).not.toHaveBeenCalled()
    })

    test('cancels an in-flight pending task', async () => {
      seed([makeExec({ id: 'e1' })])
      const cancel = mock(() => Promise.resolve())
      pendingTask = { cancel }

      const res = await app.request('/e1/cancel', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(removePendingTaskMock).toHaveBeenCalledWith('t1', { cancelled: true })
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
    })

    test('still cleans up when pending.cancel() throws', async () => {
      seed([makeExec({ id: 'e1' })])
      const cancel = mock(() => Promise.reject(new Error('boom')))
      pendingTask = { cancel }

      const res = await app.request('/e1/cancel', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(removePendingTaskMock).toHaveBeenCalledWith('t1', { cancelled: true })
    })

    test('finalizes an orphaned run (no pending task, no session to close)', async () => {
      seed([makeExec({ id: 'e1' })])
      const res = await app.request('/e1/cancel', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; orphaned?: boolean; execution: ExecutionLog }
      expect(body.orphaned).toBe(true)
      expect(body.execution.outcome).toBe('cancelled')
      expect(body.execution.errorMsg).toBe('cancelled: manual (orphaned)')
      expect(body.execution.finishedAt).toEqual(expect.any(String))
    })

    // The 'iterm'/'tmux' orphan branches shell out to osascript / tmux for
    // real (dynamic `import()`, not injected) — exercising them here would
    // either risk launching a real iTerm2 window or depend on tmux being
    // installed in whatever environment runs this suite. Left uncovered
    // deliberately rather than mocking 'node:child_process' / an ai-providers
    // package globally, which would leak into unrelated test files sharing
    // this test run's module cache.
  })
})
