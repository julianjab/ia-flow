import type {
  Checkpoint,
  DomainEvent,
  ExecutionRecord,
  ExecutionRepository,
  ExecutionStatus,
  PauseJSON,
} from '@ia-flow/agent-engine'
import { migrate } from './migrations.js'
import type { SqliteDatabase } from './SqliteDatabase.js'

export interface SqliteExecutionRepositoryOptions {
  /** La base ya abierta por el runtime (`openNodeSqlite` de `./node`, o `bun:sqlite`). El
   *  repositorio le aplica el esquema y la cierra con `close()`. */
  database: SqliteDatabase
}

interface ExecutionRow {
  id: string
  key: string
  pipeline_id: string
  status: ExecutionStatus
  started_at: string
  waited_ms: number
  closed_at: string | null
  close_reason: string | null
  pause_json: string | null
  checkpoint_json: string | null
}

/**
 * Las ejecuciones en SQLite, sobre cualquier base síncrona (`SqliteDatabase`: `node:sqlite` o
 * `bun:sqlite`) — lo que el `ExecutionStore` necesita para ocupar una task en el mismo tick. Guarda cada transición y lo que se le
 * entregó a cada ejecución, así un store nuevo sobre la misma base recupera las pausadas y lo que
 * las interrumpidas no leyeron.
 *
 * Un proceso por base: la exclusión por task y el tope viven en memoria, en el store.
 */
export class SqliteExecutionRepository implements ExecutionRepository {
  private readonly db: SqliteDatabase

  constructor(options: SqliteExecutionRepositoryOptions) {
    this.db = options.database
    this.db.exec('PRAGMA foreign_keys = ON')
    migrate(this.db)
  }

  save(record: ExecutionRecord): void {
    this.db
      .prepare(
        `INSERT INTO executions (id, key, pipeline_id, status, started_at, waited_ms, closed_at,
           close_reason, pause_json, checkpoint_json)
         VALUES ($id, $key, $pipelineId, $status, $startedAt, $waitedMs, $closedAt, $closeReason,
           $pause, $checkpoint)
         ON CONFLICT (id) DO UPDATE SET
           status = excluded.status,
           closed_at = excluded.closed_at,
           close_reason = excluded.close_reason,
           pause_json = excluded.pause_json,
           checkpoint_json = excluded.checkpoint_json`,
      )
      .run({
        $id: record.id,
        $key: record.key,
        $pipelineId: record.pipelineId,
        $status: record.status,
        $startedAt: record.startedAt,
        $waitedMs: record.waitedMs,
        $closedAt: record.closedAt ?? null,
        $closeReason: record.closeReason ?? null,
        $pause: record.pause ? JSON.stringify(record.pause) : null,
        $checkpoint: record.checkpoint ? JSON.stringify(record.checkpoint) : null,
      })
  }

  delivered(executionId: string, event: DomainEvent<any>): void {
    this.db
      .prepare(
        `INSERT INTO execution_inbox (execution_id, seq, event_json)
         VALUES ($id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM execution_inbox WHERE execution_id = $id), $event)`,
      )
      .run({ $id: executionId, $event: JSON.stringify(event) })
  }

  read(executionId: string): void {
    this.db
      .prepare('UPDATE execution_inbox SET read = 1 WHERE execution_id = ? AND read = 0')
      .run(executionId)
  }

  live(): ExecutionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM executions WHERE status IN ('running', 'paused') ORDER BY started_at, id`,
      )
      .all() as unknown as ExecutionRow[]
    return rows.map(toRecord)
  }

  unread(executionId: string): DomainEvent<any>[] {
    const rows = this.db
      .prepare(
        'SELECT event_json FROM execution_inbox WHERE execution_id = ? AND read = 0 ORDER BY seq',
      )
      .all(executionId) as Array<{ event_json: string }>
    return rows.map((row) => JSON.parse(row.event_json) as DomainEvent<any>)
  }

  /** Una ejecución guardada, por id — para inspeccionar o depurar. */
  find(executionId: string): ExecutionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId) as
      | ExecutionRow
      | undefined
    return row ? toRecord(row) : undefined
  }

  close(): void {
    this.db.close()
  }
}

function toRecord(row: ExecutionRow): ExecutionRecord {
  return {
    id: row.id,
    key: row.key,
    pipelineId: row.pipeline_id,
    status: row.status,
    startedAt: row.started_at,
    waitedMs: row.waited_ms,
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
    ...(row.close_reason ? { closeReason: row.close_reason } : {}),
    ...(row.pause_json ? { pause: JSON.parse(row.pause_json) as PauseJSON } : {}),
    ...(row.checkpoint_json ? { checkpoint: JSON.parse(row.checkpoint_json) as Checkpoint } : {}),
  }
}
