import type { Migration } from './runner.js'

// Advisory "cancel requested" marker for execution_logs rows owned by
// another process (source != null). The main daemon has no safe network
// path to actually stop a run inside a headless container (see
// routes/executions.ts), so cancelling one of those rows just stamps this
// column instead of lying that the run stopped.
const migration: Migration = {
  id: '043-execution-logs-cancel-requested',
  description: 'Add cancel_requested_at column to execution_logs',
  up(db) {
    db.run(`ALTER TABLE execution_logs ADD COLUMN cancel_requested_at TEXT`)
  },
}

export default migration
