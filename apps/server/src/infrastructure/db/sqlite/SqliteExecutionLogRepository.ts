import type { Database } from 'bun:sqlite'
import type { ExecutionLog, ExecutionLogFilters } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../../../domain/ports/IExecutionLogRepository.js'
import { createLogger } from '../../../logger.js'

const log = createLogger('execution-log-repo')

function rowToLog(r: Record<string, unknown>): ExecutionLog {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    taskId: r.task_id as string,
    taskTitle: r.task_title as string,
    agentId: r.agent_id as string,
    providerId: r.provider_id as string,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    outcome: (r.outcome as ExecutionLog['outcome']) ?? null,
    errorMsg: (r.error_msg as string | null) ?? null,
    stopReason: (r.stop_reason as string | null) ?? null,
    sessionKind: (r.session_kind as ExecutionLog['sessionKind']) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    cancelRequestedAt: (r.cancel_requested_at as string | null) ?? null,
  }
}

export class SqliteExecutionLogRepository implements IExecutionLogRepository {
  /**
   * `ownSource` scopes `sweepOrphaned` (see below) — pass the same value
   * given to SourceTaggingExecutionLogRepository (IA_FLOW_INSTANCE_ID) so a
   * restart only closes THIS process's own dangling rows, never rows
   * forwarded in from another container's RemoteExecutionLogRepository.
   */
  constructor(
    private db: Database,
    private ownSource: string | null = null,
  ) {}

  // Upsert: a retried/duplicate forward from RemoteExecutionLogRepository
  // (network blip, container restart) must overwrite the existing row
  // instead of throwing SQLITE_CONSTRAINT on the id PK.
  //
  // cancel_requested_at is the one column excluded from that overwrite
  // (COALESCE keeps the existing value when excluded.* is null): the
  // headless container that owns a forwarded row never learns an operator
  // marked it cancel-requested on the main daemon (see routes/executions.ts)
  // — RemoteExecutionLogRepository.update() re-sends its own last-known copy
  // of the row as a self-healing upsert, which would otherwise null out the
  // marker the moment the container's next progress/finish update arrives.
  insert(entry: ExecutionLog): void {
    this.db.run(
      `INSERT INTO execution_logs
        (id, project_id, task_id, task_title, agent_id, provider_id, started_at, finished_at, outcome, error_msg, stop_reason, session_kind, session_id, source, cancel_requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         task_id = excluded.task_id,
         task_title = excluded.task_title,
         agent_id = excluded.agent_id,
         provider_id = excluded.provider_id,
         started_at = excluded.started_at,
         finished_at = excluded.finished_at,
         outcome = excluded.outcome,
         error_msg = excluded.error_msg,
         stop_reason = excluded.stop_reason,
         session_kind = excluded.session_kind,
         session_id = excluded.session_id,
         source = excluded.source,
         cancel_requested_at = COALESCE(excluded.cancel_requested_at, execution_logs.cancel_requested_at)`,
      [
        entry.id,
        entry.projectId,
        entry.taskId,
        entry.taskTitle,
        entry.agentId,
        entry.providerId,
        entry.startedAt,
        entry.finishedAt,
        entry.outcome,
        entry.errorMsg,
        entry.stopReason,
        entry.sessionKind ?? null,
        entry.sessionId ?? null,
        entry.source ?? null,
        entry.cancelRequestedAt ?? null,
      ],
    )
    log.debug({ id: entry.id }, 'Inserted execution log')
  }

  update(id: string, patch: Partial<ExecutionLog>): void {
    const colMap: Record<string, string> = {
      projectId: 'project_id',
      taskId: 'task_id',
      taskTitle: 'task_title',
      agentId: 'agent_id',
      providerId: 'provider_id',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      outcome: 'outcome',
      errorMsg: 'error_msg',
      stopReason: 'stop_reason',
      sessionKind: 'session_kind',
      sessionId: 'session_id',
      source: 'source',
      cancelRequestedAt: 'cancel_requested_at',
    }

    const setClauses: string[] = []
    const params: unknown[] = []

    for (const [key, col] of Object.entries(colMap)) {
      if (key in patch && key !== 'id') {
        setClauses.push(`${col} = ?`)
        params.push(patch[key as keyof ExecutionLog] ?? null)
      }
    }

    if (setClauses.length === 0) return

    params.push(id)
    this.db.run(
      `UPDATE execution_logs SET ${setClauses.join(', ')} WHERE id = ?`,
      params as string[],
    )
    log.debug({ id }, 'Updated execution log')
  }

  list(filters: ExecutionLogFilters): ExecutionLog[] {
    const whereClauses: string[] = []
    const params: unknown[] = []

    if (filters.taskId !== undefined) {
      whereClauses.push('task_id = ?')
      params.push(filters.taskId)
    }
    const inClause = (col: string, raw: string | string[] | undefined): void => {
      if (raw === undefined) return
      const arr = Array.isArray(raw) ? raw : [raw]
      const cleaned = arr.map((v) => v.trim()).filter((v) => v.length > 0)
      if (cleaned.length === 0) return
      whereClauses.push(`${col} IN (${cleaned.map(() => '?').join(', ')})`)
      params.push(...cleaned)
    }
    inClause('project_id', filters.projectId)
    inClause('agent_id', filters.agentId)
    inClause('provider_id', filters.providerId)
    inClause('outcome', filters.outcome as string | string[] | undefined)
    inClause('source', filters.source)
    if (filters.from !== undefined) {
      whereClauses.push('started_at >= ?')
      params.push(filters.from)
    }
    if (filters.to !== undefined) {
      whereClauses.push('started_at <= ?')
      params.push(filters.to)
    }

    let sql = 'SELECT * FROM execution_logs'
    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`
    }
    sql += ' ORDER BY started_at DESC'

    if (filters.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(filters.limit)
    }

    const rows = this.db.query(sql).all(...(params as string[])) as Record<string, unknown>[]
    return rows.map(rowToLog)
  }

  listActive(): ExecutionLog[] {
    const rows = this.db
      .query('SELECT * FROM execution_logs WHERE finished_at IS NULL ORDER BY started_at DESC')
      .all() as Record<string, unknown>[]
    return rows.map(rowToLog)
  }

  getById(id: string): ExecutionLog | null {
    const row = this.db.query('SELECT * FROM execution_logs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToLog(row) : null
  }

  sweepOrphaned(reason: string): ExecutionLog[] {
    const nowIso = new Date().toISOString()
    // COALESCE keeps whatever a concurrent writer set between our SELECT and
    // UPDATE. In practice this runs on a cold server so contention is zero,
    // but it costs nothing to be safe.
    //
    // `source IS ?` scopes the sweep to rows THIS process owns (ownSource,
    // NULL for the main daemon). Without it, a main-daemon restart would
    // also mark rows forwarded from a still-running headless container
    // (subscriptions-pipeline, etc.) as errored, even though that run is
    // alive in its own process.
    //
    // The ids are captured BEFORE the UPDATE (afterwards the rows no longer
    // match `finished_at IS NULL`) so we can hand the closed rows back:
    // CompositeExecutionLogRepository replays them onto its write-only
    // mirrors, which a bulk UPDATE against this DB alone never reaches.
    const ids = (
      this.db
        .query('SELECT id FROM execution_logs WHERE finished_at IS NULL AND source IS ?')
        .all(this.ownSource) as Array<{ id: string }>
    ).map((r) => r.id)
    if (ids.length === 0) return []

    this.db.run(
      `UPDATE execution_logs
          SET finished_at = COALESCE(finished_at, ?),
              outcome     = COALESCE(outcome, 'error'),
              error_msg   = COALESCE(error_msg, ?)
        WHERE finished_at IS NULL AND source IS ?`,
      [nowIso, reason, this.ownSource],
    )

    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db
      .query(`SELECT * FROM execution_logs WHERE id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>
    return rows.map(rowToLog)
  }

  listDistinctSources(): string[] {
    const rows = this.db
      .query('SELECT DISTINCT source FROM execution_logs WHERE source IS NOT NULL ORDER BY source')
      .all() as Array<{ source: string }>
    return rows.map((r) => r.source)
  }
}
