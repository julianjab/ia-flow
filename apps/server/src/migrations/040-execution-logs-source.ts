import type { Migration } from './runner.js'

// Tags each execution_logs row with the IA_FLOW_INSTANCE_ID of the process
// that ran it — null means the main daemon itself. Populated by headless
// engine containers (subscriptions-pipeline, functional-refiner,
// implementer-accountant) via SourceTaggingExecutionLogRepository, whether
// the row stays local-only or gets forwarded to the main daemon over
// /api/remote-executions (see composition/container.ts). Lets the
// Ejecuciones/Logs UI filter by which container produced a run.
const migration: Migration = {
  id: '040-execution-logs-source',
  description: 'Add source column to execution_logs (which process ran this)',
  up(db) {
    db.run(`ALTER TABLE execution_logs ADD COLUMN source TEXT`)
  },
}

export default migration
