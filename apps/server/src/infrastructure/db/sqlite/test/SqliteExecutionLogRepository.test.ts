import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ExecutionLog } from '@ia-flow/shared'
import { SqliteExecutionLogRepository } from '../SqliteExecutionLogRepository.js'

// Mirrors migrations 021 (base table) + 023 (session_kind/session_id) + 040
// (source) + 043 (cancel_requested_at) + 045 (run telemetry) + 048 (contrato
// de cierre) — the columns SqliteExecutionLogRepository actually reads/writes.
function makeDb(): Database {
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
    source       TEXT,
    cancel_requested_at TEXT,
    duration_ms           INTEGER,
    tokens_in             INTEGER,
    tokens_out            INTEGER,
    cache_read_tokens     INTEGER,
    cache_creation_tokens INTEGER,
    iters                 INTEGER,
    tool_calls            INTEGER,
    tool_errors           INTEGER,
    failure_class         TEXT,
    run_id                TEXT,
    agent_prompt_hash     TEXT,
    initial_status        TEXT,
    on_finish             TEXT,
    on_error              TEXT,
    finalized_by_tool     INTEGER
  )`)
  return db
}

function setup(ownSource: string | null = null): SqliteExecutionLogRepository {
  return new SqliteExecutionLogRepository(makeDb(), ownSource)
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
    cancelRequestedAt: null,
    durationMs: null,
    tokensIn: null,
    tokensOut: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    iters: null,
    toolCalls: null,
    toolErrors: null,
    failureClass: null,
    runId: null,
    agentPromptHash: null,
    initialStatus: null,
    onFinish: null,
    onError: null,
    finalizedByTool: null,
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

  test('insert upserts — a duplicate id overwrites instead of throwing', () => {
    repo.insert(fakeEntry())
    expect(() => repo.insert(fakeEntry({ outcome: 'success', taskTitle: 'Retried' }))).not.toThrow()
    const row = repo.getById('exec-1')
    expect(row?.outcome).toBe('success')
    expect(row?.taskTitle).toBe('Retried')
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

  test('a re-forwarded upsert without cancelRequestedAt does not erase a previously marked one', () => {
    // Regression: RemoteExecutionLogRepository.update() forwards its own
    // last-known copy of a row as a self-healing upsert (op: 'insert'),
    // which never carries cancelRequestedAt (the container that owns the
    // row never learns an operator marked it here). That upsert must not
    // null out the marker.
    repo.insert(fakeEntry())
    repo.update('exec-1', { cancelRequestedAt: '2026-01-01T00:05:00.000Z' })
    repo.insert(fakeEntry({ outcome: 'success', finishedAt: '2026-01-01T00:10:00.000Z' }))
    expect(repo.getById('exec-1')?.cancelRequestedAt).toBe('2026-01-01T00:05:00.000Z')
    expect(repo.getById('exec-1')?.outcome).toBe('success')
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

  test('sweepOrphaned closes every open row and returns the closed rows', () => {
    repo.insert(fakeEntry({ id: 'a', finishedAt: null }))
    repo.insert(fakeEntry({ id: 'b', finishedAt: '2026-01-01T00:05:00.000Z' }))
    const changed = repo.sweepOrphaned('server restart')
    expect(changed.map((r) => r.id)).toEqual(['a'])
    // Returned rows carry the POST-sweep values so callers can replay them
    // verbatim onto a write-only mirror.
    expect(changed[0]?.outcome).toBe('error')
    expect(changed[0]?.errorMsg).toBe('server restart')
    expect(changed[0]?.finishedAt).not.toBeNull()
    const row = repo.getById('a')
    expect(row?.outcome).toBe('error')
    expect(row?.errorMsg).toBe('server restart')
    expect(row?.finishedAt).not.toBeNull()
    // Already-finished rows are left untouched.
    expect(repo.getById('b')?.errorMsg).toBeNull()
  })

  test('sweepOrphaned (main daemon, ownSource=null) never touches rows forwarded from a headless container', () => {
    const db = makeDb()
    const mainRepo = new SqliteExecutionLogRepository(db, null)
    mainRepo.insert(fakeEntry({ id: 'local', finishedAt: null, source: null }))
    mainRepo.insert(fakeEntry({ id: 'remote', finishedAt: null, source: 'subscriptions-pipeline' }))

    const changed = mainRepo.sweepOrphaned('server restart')

    expect(changed.map((r) => r.id)).toEqual(['local'])
    expect(mainRepo.getById('local')?.outcome).toBe('error')
    // Still running in its own container as far as this daemon can tell —
    // untouched.
    expect(mainRepo.getById('remote')?.outcome).toBeNull()
    expect(mainRepo.getById('remote')?.finishedAt).toBeNull()
  })

  test('sweepOrphaned scoped to a headless container only touches its own tagged rows', () => {
    const db = makeDb()
    const scoped = new SqliteExecutionLogRepository(db, 'subscriptions-pipeline')
    scoped.insert(fakeEntry({ id: 'mine', finishedAt: null, source: 'subscriptions-pipeline' }))
    scoped.insert(fakeEntry({ id: 'other', finishedAt: null, source: 'functional-refiner' }))
    scoped.insert(fakeEntry({ id: 'main', finishedAt: null, source: null }))

    const changed = scoped.sweepOrphaned('server restart')

    expect(changed.map((r) => r.id)).toEqual(['mine'])
    expect(scoped.getById('mine')?.outcome).toBe('error')
    expect(scoped.getById('other')?.outcome).toBeNull()
    expect(scoped.getById('main')?.outcome).toBeNull()
  })

  test('listDistinctSources returns sorted non-null sources only', () => {
    repo.insert(fakeEntry({ id: 'a', source: 'functional-refiner' }))
    repo.insert(fakeEntry({ id: 'b', source: 'subscriptions-pipeline' }))
    repo.insert(fakeEntry({ id: 'c', source: null }))
    expect(repo.listDistinctSources()).toEqual(['functional-refiner', 'subscriptions-pipeline'])
  })
})

describe('SqliteExecutionLogRepository.stats', () => {
  let repo: SqliteExecutionLogRepository

  beforeEach(() => {
    repo = setup()
  })

  function seed(repo: SqliteExecutionLogRepository): void {
    // agent-a: 2 success, 1 budget-exhausted truncation
    repo.insert(
      fakeEntry({
        id: 'a1',
        agentId: 'agent-a',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z',
        outcome: 'success',
        durationMs: 1000,
        tokensIn: 100,
        tokensOut: 10,
        toolCalls: 4,
        toolErrors: 0,
        agentPromptHash: 'aaa',
      }),
    )
    repo.insert(
      fakeEntry({
        id: 'a2',
        agentId: 'agent-a',
        startedAt: '2026-01-02T00:00:00.000Z',
        finishedAt: '2026-01-02T00:01:00.000Z',
        outcome: 'success',
        durationMs: 3000,
        tokensIn: 200,
        tokensOut: 20,
        toolCalls: 6,
        toolErrors: 1,
        agentPromptHash: 'aaa',
      }),
    )
    repo.insert(
      fakeEntry({
        id: 'a3',
        agentId: 'agent-a',
        startedAt: '2026-01-03T00:00:00.000Z',
        finishedAt: '2026-01-03T00:01:00.000Z',
        outcome: 'truncated',
        failureClass: 'budget_exhausted',
        durationMs: 2000,
        agentPromptHash: 'bbb',
      }),
    )
    // agent-b: 1 error
    repo.insert(
      fakeEntry({
        id: 'b1',
        agentId: 'agent-b',
        projectId: 'proj-2',
        startedAt: '2026-01-04T00:00:00.000Z',
        finishedAt: '2026-01-04T00:01:00.000Z',
        outcome: 'error',
        failureClass: 'infra_error',
      }),
    )
    // still running — must be excluded from every count
    repo.insert(fakeEntry({ id: 'x1', agentId: 'agent-a', startedAt: '2026-01-05T00:00:00.000Z' }))
  }

  test('groups finished runs by agent and ignores in-flight rows', () => {
    seed(repo)
    const stats = repo.stats({})

    const a = stats.agents.find((x) => x.agentId === 'agent-a')!
    expect(a.runs).toBe(3)
    expect(a.success).toBe(2)
    expect(a.truncated).toBe(1)
    expect(a.successRate).toBeCloseTo(2 / 3)
    expect(a.failureClasses).toEqual({ budget_exhausted: 1 })
    expect(a.avgDurationMs).toBe(2000)
    expect(a.tokensIn).toBe(300)
    expect(a.toolCalls).toBe(10)
    expect(a.toolErrors).toBe(1)
    // The in-flight row is excluded, so the last run is a3, not x1.
    expect(a.lastRunAt).toBe('2026-01-03T00:00:00.000Z')
    expect(a.promptVersions).toBe(2)

    expect(stats.totals.runs).toBe(4)
    expect(stats.totals.successRate).toBeCloseTo(0.5)
    expect(stats.totals.failureClasses).toEqual({ budget_exhausted: 1, infra_error: 1 })
  })

  test('filters by project and time window', () => {
    seed(repo)
    expect(repo.stats({ projectId: 'proj-2' }).agents.map((a) => a.agentId)).toEqual(['agent-b'])

    const windowed = repo.stats({
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-03T23:59:59.000Z',
    })
    expect(windowed.totals.runs).toBe(2)
    expect(windowed.from).toBe('2026-01-02T00:00:00.000Z')
  })

  test('reports a null success rate rather than 0% when there is nothing to rate', () => {
    const stats = repo.stats({})
    expect(stats.agents).toEqual([])
    expect(stats.totals.successRate).toBeNull()
  })

  test('treats pre-migration rows as zero tokens, not null', () => {
    repo.insert(
      fakeEntry({
        id: 'legacy',
        agentId: 'agent-legacy',
        finishedAt: '2026-01-01T00:01:00.000Z',
        outcome: 'success',
      }),
    )
    const agent = repo.stats({}).agents[0]!
    expect(agent.tokensIn).toBe(0)
    expect(agent.toolCalls).toBe(0)
    expect(agent.avgDurationMs).toBeNull()
  })
})

describe('SqliteExecutionLogRepository.agentDetail', () => {
  let repo: SqliteExecutionLogRepository

  beforeEach(() => {
    repo = setup()
    // Two prompt versions of the same agent: the old one healthy, the new one
    // failing. This is the whole point of the view — an aggregate rate would
    // average these into one unremarkable number.
    for (const i of [1, 2, 3, 4]) {
      repo.insert(
        fakeEntry({
          id: `old-${i}`,
          agentId: 'implementer',
          startedAt: `2026-01-0${i}T00:00:00.000Z`,
          finishedAt: `2026-01-0${i}T00:01:00.000Z`,
          outcome: 'success',
          agentPromptHash: 'v1',
        }),
      )
    }
    for (const i of [5, 6, 7] as const) {
      repo.insert(
        fakeEntry({
          id: `new-${i}`,
          agentId: 'implementer',
          startedAt: `2026-01-0${i}T00:00:00.000Z`,
          finishedAt: `2026-01-0${i}T00:01:00.000Z`,
          outcome: 'error',
          failureClass: 'tool_failure',
          errorMsg: 'tool boom',
          agentPromptHash: 'v2',
        }),
      )
    }
  })

  test('breaks the success rate down per prompt version, newest first', () => {
    const detail = repo.agentDetail('implementer', {})!
    expect(detail.byPromptVersion.map((v) => v.promptHash)).toEqual(['v2', 'v1'])
    expect(detail.byPromptVersion[0]!.successRate).toBe(0)
    expect(detail.byPromptVersion[1]!.successRate).toBe(1)
  })

  test('keeps the header identical to the number the panel showed', () => {
    const fromStats = repo.stats({}).agents.find((a) => a.agentId === 'implementer')
    expect(repo.agentDetail('implementer', {})!.health).toEqual(fromStats!)
  })

  test('groups runs from before prompt hashing into one bucket instead of dropping them', () => {
    repo.insert(
      fakeEntry({
        id: 'legacy',
        agentId: 'implementer',
        startedAt: '2025-12-01T00:00:00.000Z',
        finishedAt: '2025-12-01T00:01:00.000Z',
        outcome: 'success',
      }),
    )
    const detail = repo.agentDetail('implementer', {})!
    const legacy = detail.byPromptVersion.find((v) => v.promptHash === null)
    expect(legacy?.runs).toBe(1)
  })

  test('lists only failed runs, newest first, with a truncated error', () => {
    const detail = repo.agentDetail('implementer', {})!
    expect(detail.recentFailures.map((f) => f.id)).toEqual(['new-7', 'new-6', 'new-5'])
    expect(detail.recentFailures[0]!.errorExcerpt).toBe('tool boom')
  })

  test('caps a huge error message instead of shipping the whole raw response', () => {
    repo.insert(
      fakeEntry({
        id: 'huge',
        agentId: 'implementer',
        startedAt: '2026-02-01T00:00:00.000Z',
        finishedAt: '2026-02-01T00:01:00.000Z',
        outcome: 'truncated',
        errorMsg: 'x'.repeat(5000),
      }),
    )
    const excerpt = repo.agentDetail('implementer', {})!.recentFailures[0]!.errorExcerpt!
    expect(excerpt.length).toBe(400)
  })

  test('buckets runs by day', () => {
    const detail = repo.agentDetail('implementer', {})!
    expect(detail.byDay[0]).toEqual({ day: '2026-01-01', runs: 1, success: 1 })
    expect(detail.byDay).toHaveLength(7)
  })

  test('returns null for an agent with no finished runs in the window', () => {
    expect(repo.agentDetail('nobody', {})).toBeNull()
    expect(repo.agentDetail('implementer', { from: '2027-01-01T00:00:00.000Z' })).toBeNull()
  })
})
