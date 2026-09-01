import type { Database } from 'bun:sqlite'
import type { RunMessage, Wait, WhenCondition } from '@ia-flow/shared'
import type { IRunMessageRepository } from '../../../domain/ports/IRunMessageRepository.js'
import type { IWaitRepository } from '../../../domain/ports/IWaitRepository.js'

function rowToWait(r: Record<string, unknown>): Wait {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    taskId: r.task_id as string,
    agentId: r.agent_id as string,
    on: JSON.parse(r.on_types as string) as string[],
    when: r.when_conditions
      ? (JSON.parse(r.when_conditions as string) as WhenCondition[] | Record<string, string>)
      : undefined,
    expiresAt: r.expires_at as string,
    resumeWith: (r.resume_with as string | null) ?? undefined,
    createdByRun: (r.created_by_run as string | null) ?? undefined,
    checkpoint: r.checkpoint
      ? (JSON.parse(r.checkpoint as string) as Record<string, unknown>)
      : null,
    createdAt: r.created_at as string,
  }
}

function rowToMessage(r: Record<string, unknown>): RunMessage {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    runId: (r.run_id as string | null) ?? null,
    body: r.body as string,
    author: (r.author as string | null) ?? undefined,
    source: (r.source as string | null) ?? undefined,
    createdAt: r.created_at as string,
    deliveredAt: (r.delivered_at as string | null) ?? null,
  }
}

export class SqliteWaitRepository implements IWaitRepository {
  constructor(private readonly db: Database) {}

  async listByProject(projectId: string): Promise<Wait[]> {
    const rows = this.db
      .query('SELECT * FROM waits WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as Record<string, unknown>[]
    return rows.map(rowToWait)
  }

  async listExpired(now: string): Promise<Wait[]> {
    const rows = this.db
      .query('SELECT * FROM waits WHERE expires_at <= ? ORDER BY expires_at')
      .all(now) as Record<string, unknown>[]
    return rows.map(rowToWait)
  }

  async getByTask(taskId: string): Promise<Wait | null> {
    // `ORDER BY created_at DESC`: si por un bug hubiera dos, la más reciente es
    // la que el agente pidió último — devolver ésa es menos sorprendente que
    // devolver una vieja que ya no representa nada.
    const row = this.db
      .query('SELECT * FROM waits WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(taskId) as Record<string, unknown> | undefined
    return row ? rowToWait(row) : null
  }

  async create(wait: Wait): Promise<Wait> {
    this.db.run(
      `INSERT INTO waits (
         id, project_id, task_id, agent_id, on_types, when_conditions,
         expires_at, resume_with, created_by_run, checkpoint, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        wait.id,
        wait.projectId,
        wait.taskId,
        wait.agentId,
        JSON.stringify(wait.on),
        wait.when ? JSON.stringify(wait.when) : null,
        wait.expiresAt,
        wait.resumeWith ?? null,
        wait.createdByRun ?? null,
        wait.checkpoint ? JSON.stringify(wait.checkpoint) : null,
        wait.createdAt,
      ],
    )
    return wait
  }

  async consume(id: string): Promise<boolean> {
    return this.db.run('DELETE FROM waits WHERE id = ?', [id]).changes > 0
  }
}

/**
 * La cola de mensajes. Comparte migración con las esperas pero no consumidor,
 * así que es una clase aparte — ver `IRunMessageRepository`.
 */
export class SqliteRunMessageRepository implements IRunMessageRepository {
  constructor(private readonly db: Database) {}

  async enqueue(message: RunMessage): Promise<RunMessage> {
    this.db.run(
      `INSERT INTO run_messages (id, task_id, run_id, body, author, source, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        message.id,
        message.taskId,
        message.runId ?? null,
        message.body,
        message.author ?? null,
        message.source ?? null,
        message.createdAt,
      ],
    )
    return message
  }

  async pending(taskId: string): Promise<RunMessage[]> {
    const rows = this.db
      .query(
        'SELECT * FROM run_messages WHERE task_id = ? AND delivered_at IS NULL ORDER BY created_at',
      )
      .all(taskId) as Record<string, unknown>[]
    return rows.map(rowToMessage)
  }

  async markDelivered(ids: string[], runId: string): Promise<void> {
    if (!ids.length) return
    const now = new Date().toISOString()
    // Transaccional: marcar la mitad dejaría al próximo turno leyendo un
    // mensaje que el modelo ya vio, y el agente lo trataría como nuevo.
    this.db.transaction(() => {
      for (const id of ids) {
        this.db.run('UPDATE run_messages SET delivered_at = ?, run_id = ? WHERE id = ?', [
          now,
          runId,
          id,
        ])
      }
    })()
  }
}
