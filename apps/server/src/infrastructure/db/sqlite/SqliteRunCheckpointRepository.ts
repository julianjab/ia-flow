import type { Database } from 'bun:sqlite'
import type {
  IRunCheckpointRepository,
  RunCheckpoint,
} from '../../../domain/ports/IRunCheckpointRepository.js'

function rowToCheckpoint(r: Record<string, unknown>): RunCheckpoint {
  return {
    runId: r.run_id as string,
    taskId: r.task_id as string,
    agentId: (r.agent_id as string | null) ?? undefined,
    projectId: (r.project_id as string | null) ?? undefined,
    state: JSON.parse(r.state as string),
    attempts: (r.attempts as number) ?? 0,
    updatedAt: r.updated_at as string,
  }
}

export class SqliteRunCheckpointRepository implements IRunCheckpointRepository {
  constructor(private readonly db: Database) {}

  async save(input: {
    runId: string
    taskId: string
    agentId?: string
    projectId?: string
    state: unknown
    attempts?: number
  }): Promise<void> {
    // `attempts` queda FUERA del UPDATE del upsert a propósito: sólo cuenta en
    // el INSERT. Si el UPDATE lo tocara, el contador dependería de en qué
    // vuelta del loop murió el proceso en vez de cuántas veces se reanudó —
    // y es lo único que frena el bucle de reinicios.
    this.db.run(
      `INSERT INTO run_checkpoints (run_id, task_id, agent_id, project_id, state, attempts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         task_id    = excluded.task_id,
         agent_id   = excluded.agent_id,
         project_id = excluded.project_id,
         state      = excluded.state,
         updated_at = excluded.updated_at`,
      [
        input.runId,
        input.taskId,
        input.agentId ?? null,
        input.projectId ?? null,
        JSON.stringify(input.state),
        input.attempts ?? 0,
        new Date().toISOString(),
      ],
    )
  }

  async getByTask(taskId: string): Promise<RunCheckpoint | null> {
    // El más reciente: una task que pasó dos veces por el pipeline puede tener
    // el checkpoint de un run viejo que nadie limpió (el proceso murió antes
    // del cierre). El último es el que representa dónde va.
    const row = this.db
      .query('SELECT * FROM run_checkpoints WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(taskId) as Record<string, unknown> | undefined
    return row ? rowToCheckpoint(row) : null
  }

  async delete(runId: string): Promise<void> {
    this.db.run('DELETE FROM run_checkpoints WHERE run_id = ?', [runId])
  }
}
