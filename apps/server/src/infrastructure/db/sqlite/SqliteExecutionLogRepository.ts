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
  }
}

export class SqliteExecutionLogRepository implements IExecutionLogRepository {
  constructor(private db: Database) {}

  insert(entry: ExecutionLog): void {
    this.db.run(
      `INSERT INTO execution_logs
        (id, project_id, task_id, task_title, agent_id, provider_id, started_at, finished_at, outcome, error_msg, stop_reason, session_kind, session_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  sweepOrphaned(reason: string): number {
    const nowIso = new Date().toISOString()
    // COALESCE keeps whatever a concurrent writer set between our SELECT and
    // UPDATE. In practice this runs on a cold server so contention is zero,
    // but it costs nothing to be safe.
    const res = this.db.run(
      `UPDATE execution_logs
          SET finished_at = COALESCE(finished_at, ?),
              outcome     = COALESCE(outcome, 'error'),
              error_msg   = COALESCE(error_msg, ?)
        WHERE finished_at IS NULL`,
      [nowIso, reason],
    )
    return res.changes ?? 0
  }

  listDistinctSources(): string[] {
    const rows = this.db
      .query('SELECT DISTINCT source FROM execution_logs WHERE source IS NOT NULL ORDER BY source')
      .all() as Array<{ source: string }>
    return rows.map((r) => r.source)
  }
}
