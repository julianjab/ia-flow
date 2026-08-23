import { classifyFailure } from '@ia-flow/agent-engine'
import type { Migration } from './runner.js'

// Backfill for the telemetry columns added in 045, over runs that finished
// before it existed.
//
// Two of those columns are recoverable from data the row already carried:
//   • duration_ms  — every finished row has started_at + finished_at.
//   • failure_class — `classifyFailure` needs outcome + stop_reason +
//     error_msg, all of which predate 045.
// The rest (tokens, iters, tool counters, prompt hash) are genuinely gone:
// nobody measured them at the time, and inventing a zero would be worse than
// a null, which at least reads as "not measured".
//
// The classification runs through the same `classifyFailure` the engine uses
// live, rather than a CASE expression in SQL — a second copy of the rules
// would drift from the real one the first time a class is added.
//
// One caveat worth knowing when reading old rows: `no_op` and `tool_failure`
// can never appear in backfilled data, since both are decided from tool
// counters these rows don't have. A historical `unknown` may well have been
// a tool failure at the time.
const migration: Migration = {
  id: '046-backfill-execution-telemetry',
  description: 'Backfill duration_ms and failure_class for pre-045 execution logs',
  up(db) {
    // SQLite has no date-diff returning ms; julianday gives fractional days.
    // Guarded on duration_ms IS NULL so re-running never overwrites a value
    // the engine measured directly.
    db.run(`UPDATE execution_logs
               SET duration_ms = CAST(
                     (julianday(finished_at) - julianday(started_at)) * 86400000 AS INTEGER)
             WHERE duration_ms IS NULL
               AND finished_at IS NOT NULL
               AND started_at IS NOT NULL
               AND julianday(finished_at) >= julianday(started_at)`)

    const rows = db
      .query(`SELECT id, outcome, stop_reason, error_msg
                FROM execution_logs
               WHERE failure_class IS NULL AND finished_at IS NOT NULL`)
      .all() as Array<{
      id: string
      outcome: 'success' | 'error' | 'cancelled' | 'truncated' | null
      stop_reason: string | null
      error_msg: string | null
    }>

    const update = db.prepare(`UPDATE execution_logs SET failure_class = ? WHERE id = ?`)
    for (const row of rows) {
      const failureClass = classifyFailure({
        outcome: row.outcome,
        stopReason: row.stop_reason,
        errorMsg: row.error_msg,
        // Explicitly absent: these rows have no tool counters, and passing
        // 0 would make every one of them look like a `no_op`.
        toolCalls: null,
        toolErrors: null,
      })
      if (failureClass !== null) update.run(failureClass, row.id)
    }
  },
}

export default migration
