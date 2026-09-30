import type { TraceJournal, TraceRecord } from '@ia-flow/telemetry'
import { migrate } from './migrations.js'
import type { SqliteDatabase, SqliteStatement } from './SqliteDatabase.js'

export interface SqliteTraceJournalOptions {
  /** La base ya abierta; se le aplica el esquema. Puede ser la misma del store. */
  database: SqliteDatabase
  /** Después de guardar cada registro (ej. empujarlo por SSE). Si tira, se ignora. */
  onWrite?: (record: TraceRecord) => void
}

/**
 * `execution_trace` en SQLite: cada `TraceRecord` que arma `traceRecorder` (spans al empezar y al
 * terminar, logs), en el momento — sin lotes, así una tool en curso ya se ve. `seq` da el orden.
 * Lo lee `SqliteActivityReader.trace`.
 */
export class SqliteTraceJournal implements TraceJournal {
  private readonly insert: SqliteStatement
  private readonly onWrite?: (record: TraceRecord) => void

  constructor(options: SqliteTraceJournalOptions) {
    migrate(options.database)
    this.onWrite = options.onWrite
    this.insert = options.database.prepare(
      `INSERT INTO execution_trace (execution_id, kind, phase, name, scope, level, status,
         status_message, start_time, end_time, duration_ms, trace_id, span_id, parent_span_id,
         origin, attributes_json)
       VALUES ($executionId, $kind, $phase, $name, $scope, $level, $status, $statusMessage,
         $startTime, $endTime, $durationMs, $traceId, $spanId, $parentSpanId, $origin,
         $attributes)`,
    )
  }

  write(record: TraceRecord): void {
    this.insert.run({
      $executionId: record.executionId,
      $kind: record.kind,
      $phase: record.phase ?? null,
      $name: record.name,
      $scope: record.scope ?? null,
      $level: record.level ?? null,
      $status: record.status ?? null,
      $statusMessage: record.statusMessage ?? null,
      $startTime: record.startTime,
      $endTime: record.endTime ?? null,
      $durationMs: record.durationMs ?? null,
      $traceId: record.traceId,
      $spanId: record.spanId,
      $parentSpanId: record.parentSpanId ?? null,
      $origin: record.origin,
      $attributes: JSON.stringify(record.attributes),
    })
    if (!this.onWrite) return
    try {
      this.onWrite(record)
    } catch {
      // Quien escucha no puede romper la traza.
    }
  }
}
