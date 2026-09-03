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

/** Cuánto puede seguir `deferred` (cap de proyecto/agente/provider, lock de
 *  la task tomado) una fila sin que cuente como intento fallido antes de
 *  darla por perdida igual. `deferred` no es un fallo del agente —el motivo
 *  típico es justo el overload que produjo el abort original— así que no
 *  quema `attempts`, pero sin este techo un proyecto permanentemente al tope
 *  reintentaría cada `BACKOFF_FLOOR_MS` para siempre. */
const MAX_DEFER_AGE_MS = 2 * 60 * 60_000

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

  /** El intento contra una fila ya abierta no llegó a un cierre limpio —
   *  mismo backoff acotado, sea porque el agente volvió a abortar
   *  (`recordAbort`) o porque el retry ni corrió un run de verdad (dispatch
   *  `skipped`/`deferred`, un fallo de infra al despachar, o una fila
   *  `retrying` que nunca volvió — `reconcileStale`). Un solo contador
   *  acotado para las tres causas: la alternativa (no contar las dos
   *  últimas) es un retry sin techo que le pega a la fuente cada 30s para
   *  siempre. */
  private bumpAttempt(
    prev: AgentAbortRecord,
    patch: { runId?: string | null; errorMsg?: string | null },
  ): AgentAbortRecord {
    const now = new Date().toISOString()
    const attempts = prev.attempts + 1
    const exhausted = attempts >= prev.maxAttempts
    const status: AgentAbortRecord['status'] = exhausted ? 'exhausted' : 'pending'
    const nextRetryAt = exhausted ? null : new Date(Date.now() + backoffMs(attempts)).toISOString()
    this.db.run(
      `UPDATE agent_aborts
       SET run_id = ?, error_msg = ?, attempts = ?, status = ?, next_retry_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        patch.runId ?? prev.runId,
        patch.errorMsg ?? prev.errorMsg,
        attempts,
        status,
        nextRetryAt,
        now,
        prev.id,
      ],
    )
    return {
      ...prev,
      runId: patch.runId ?? prev.runId,
      errorMsg: patch.errorMsg ?? prev.errorMsg,
      attempts,
      status,
      nextRetryAt,
      updatedAt: now,
    }
  }

  recordAbort(input: {
    projectId: string
    taskId: string
    agentId: string
    runId?: string
    reason: string
    errorMsg?: string
  }): AgentAbortRecord {
    const existing = this.findOpen(input.taskId, input.agentId)
    if (existing) {
      return this.bumpAttempt(rowToRecord(existing), {
        runId: input.runId ?? null,
        errorMsg: input.errorMsg ?? null,
      })
    }

    const now = new Date().toISOString()
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

  deferRetry(id: string): void {
    const row = this.db.query('SELECT * FROM agent_aborts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return
    const prev = rowToRecord(row)
    const now = Date.now()
    const nowIso = new Date(now).toISOString()

    if (now - new Date(prev.createdAt).getTime() > MAX_DEFER_AGE_MS) {
      // Lleva demasiado esperando capacidad — dejar de insistir solo. El
      // botón manual sigue disponible (`exhausted` cuenta como "abierta").
      this.db.run(
        `UPDATE agent_aborts SET status = 'exhausted', next_retry_at = NULL, updated_at = ? WHERE id = ?`,
        [nowIso, id],
      )
      return
    }
    this.db.run(`UPDATE agent_aborts SET next_retry_at = ?, updated_at = ? WHERE id = ?`, [
      new Date(now + BACKOFF_FLOOR_MS).toISOString(),
      nowIso,
      id,
    ])
  }

  listStaleRetrying(staleBeforeIso: string): AgentAbortRecord[] {
    // `pending` + `next_retry_at IS NULL` es "un dispatch la tomó" (ver
    // `markRetrying`). Sólo lectura a propósito: si sigue así mucho después
    // de que se despachó puede ser un run legítimo todavía corriendo, así
    // que decidir si está realmente huérfana necesita cruzarla contra los
    // runs vivos — algo que este repo no tiene cómo saber. Ver
    // `daemon.ts`'s `startAbortRetrySweep`.
    const rows = this.db
      .query(
        `SELECT * FROM agent_aborts
         WHERE status = 'pending' AND next_retry_at IS NULL AND updated_at <= ?`,
      )
      .all(staleBeforeIso) as Record<string, unknown>[]
    return rows.map(rowToRecord)
  }

  recordFailedAttempt(id: string, errorMsg: string): void {
    const row = this.db.query('SELECT * FROM agent_aborts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return
    this.bumpAttempt(rowToRecord(row), { errorMsg })
  }
}
