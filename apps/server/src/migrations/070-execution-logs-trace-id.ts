import type { Migration } from './runner.js'

// El id que atraviesa un webhook entero — desde el delivery en
// `routes/webhooks.ts` hasta cada fila de `execution_logs` que ese delivery
// terminó produciendo. Ver el comentario de `traceId` en
// `packages/shared/src/schemas.ts` (ExecutionLogSchema) y en
// `packages/shared/src/events.ts` (EngineEventSchema) para el porqué.
//
// Idempotente con el `hasColumn` que documenta la 053.
const COLUMNS: Array<[name: string, ddl: string]> = [
  ['trace_id', 'ALTER TABLE execution_logs ADD COLUMN trace_id TEXT'],
]

const migration: Migration = {
  id: '070-execution-logs-trace-id',
  description: 'execution_logs: trace_id',
  up(db) {
    const columns = db
      .query(`SELECT name FROM pragma_table_info('execution_logs')`)
      .all() as Array<{ name: string }>
    const existing = new Set(columns.map((c) => c.name))
    for (const [name, ddl] of COLUMNS) {
      if (!existing.has(name)) db.run(ddl)
    }
  },
}

export default migration
