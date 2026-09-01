import type { Migration } from './runner.js'

// El run anterior de una task que se reanuda desde `run_checkpoints`
// (AgentOrchestrator.loadResume) ya sabe cuál era ese run — `cp.runId` — pero
// hoy se descarta después de loguearlo. Sin este campo, dos filas de
// `execution_logs` sobre la misma task (un "orphaned: runner restart before
// finalize" seguido de un dispatch nuevo) se ven como dos runs sin relación,
// cuando en realidad el segundo retomó la conversación del primero.
//
// Idempotente con el `hasColumn` que documenta la 053.
const COLUMNS: Array<[name: string, ddl: string]> = [
  ['resumed_from_run_id', 'ALTER TABLE execution_logs ADD COLUMN resumed_from_run_id TEXT'],
]

const migration: Migration = {
  id: '068-execution-logs-resumed-from',
  description: 'execution_logs: resumed_from_run_id',
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
