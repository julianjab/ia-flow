import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  AgentAbortRecord,
  IAgentAbortRepository,
} from '../../../domain/ports/IAgentAbortRepository.js'

/** Piso del backoff exponencial entre retries automáticos. */
const BACKOFF_FLOOR_MS = 30_000
/** Techo — un overload de minutos no debería hacer esperar más de esto entre
 *  intentos. */
const BACKOFF_CEIL_MS = 10 * 60_000
/** Tope de intentos automáticos antes de marcar `exhausted` y dejar de
 *  reintentar solo. El botón manual sigue funcionando sobre una fila agotada
 *  (ver `recordAbort`: "abierta" incluye `exhausted`). */
const DEFAULT_MAX_ATTEMPTS = 3

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_FLOOR_MS * 2 ** (attempts - 1), BACKOFF_CEIL_MS)
}

function rowToRecord(r: Record<string, unknown>): AgentAbortRecord {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    taskId: r.task_id as string,
    agentId: r.agent_id as string,
    runId: (r.run_id as string | null) ?? null,
    reason: r.reason as string,
    errorMsg: (r.error_msg as string | null) ?? null,
    attempts: r.attempts as number,
    maxAttempts: r.max_attempts as number,
    status: r.status as AgentAbortRecord['status'],
    nextRetryAt: (r.next_retry_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    resolvedAt: (r.resolved_at as string | null) ?? null,
  }
}

export class SqliteAgentAbortRepository implements IAgentAbortRepository {
  constructor(private readonly db: Database) {}

  private findOpen(taskId: string, agentId: string): Record<string, unknown> | undefined {
    return this.db
      .query(
        `SELECT * FROM agent_aborts
         WHERE task_id = ? AND agent_id = ? AND status IN ('pending', 'exhausted')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId, agentId) as Record<string, unknown> | undefined
  }

  recordAbort(input: {
    projectId: string
    taskId: string
    agentId: string
    runId?: string
    reason: string
    errorMsg?: string
  }): AgentAbortRecord {
    const now = new Date().toISOString()
    const existing = this.findOpen(input.taskId, input.agentId)

    if (!existing) {
      const record: AgentAbortRecord = {
        id: randomUUID(),
        projectId: input.projectId,
        taskId: input.taskId,
        agentId: input.agentId,
        runId: input.runId ?? null,
        reason: input.reason,
        errorMsg: input.errorMsg ?? null,
        attempts: 1,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        status: 'pending',
        nextRetryAt: new Date(Date.now() + backoffMs(1)).toISOString(),
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      }
      this.db.run(
        `INSERT INTO agent_aborts (
           id, project_id, task_id, agent_id, run_id, reason, error_msg,
           attempts, max_attempts, status, next_retry_at, created_at, updated_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          record.id,
          record.projectId,
          record.taskId,
          record.agentId,
          record.runId,
          record.reason,
          record.errorMsg,
          record.attempts,
          record.maxAttempts,
          record.status,
          record.nextRetryAt,
          record.createdAt,
          record.updatedAt,
        ],
      )
      return record
    }

    const prev = rowToRecord(existing)
    const attempts = prev.attempts + 1
    const exhausted = attempts >= prev.maxAttempts
    const status: AgentAbortRecord['status'] = exhausted ? 'exhausted' : 'pending'
    const nextRetryAt = exhausted ? null : new Date(Date.now() + backoffMs(attempts)).toISOString()
    this.db.run(
      `UPDATE agent_aborts
       SET run_id = ?, error_msg = ?, attempts = ?, status = ?, next_retry_at = ?, updated_at = ?
       WHERE id = ?`,
      [input.runId ?? null, input.errorMsg ?? null, attempts, status, nextRetryAt, now, prev.id],
    )
    return {
      ...prev,
      runId: input.runId ?? null,
      errorMsg: input.errorMsg ?? null,
      attempts,
      status,
      nextRetryAt,
      updatedAt: now,
    }
  }

  resolveOpen(taskId: string, agentId: string): void {
    const now = new Date().toISOString()
    this.db.run(
      `UPDATE agent_aborts
       SET status = 'resolved', next_retry_at = NULL, resolved_at = ?, updated_at = ?
       WHERE task_id = ? AND agent_id = ? AND status IN ('pending', 'exhausted')`,
      [now, now, taskId, agentId],
    )
  }

  listDue(atIso: string): AgentAbortRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM agent_aborts
         WHERE status = 'pending' AND next_retry_at IS NOT NULL AND next_retry_at <= ?
         ORDER BY next_retry_at`,
      )
      .all(atIso) as Record<string, unknown>[]
    return rows.map(rowToRecord)
  }

  list(projectId?: string): AgentAbortRecord[] {
    const rows = projectId
      ? (this.db
          .query(
            `SELECT * FROM agent_aborts WHERE project_id = ? AND status != 'resolved'
             ORDER BY updated_at DESC`,
          )
          .all(projectId) as Record<string, unknown>[])
      : (this.db
          .query(`SELECT * FROM agent_aborts WHERE status != 'resolved' ORDER BY updated_at DESC`)
          .all() as Record<string, unknown>[])
    return rows.map(rowToRecord)
  }

  get(id: string): AgentAbortRecord | null {
    const row = this.db.query('SELECT * FROM agent_aborts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToRecord(row) : null
  }

  markRetrying(id: string): void {
    this.db.run(`UPDATE agent_aborts SET next_retry_at = NULL, updated_at = ? WHERE id = ?`, [
      new Date().toISOString(),
      id,
    ])
  }

  reschedule(id: string): void {
    const now = new Date().toISOString()
    this.db.run(
      `UPDATE agent_aborts SET next_retry_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      [new Date(Date.now() + BACKOFF_FLOOR_MS).toISOString(), now, id],
    )
  }
}
