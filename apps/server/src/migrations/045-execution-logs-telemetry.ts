import type { Migration } from './runner.js'

// Run telemetry on execution_logs. Until now a finished run recorded only
// `outcome` + a free-text `error_msg`, which can't be grouped: you could see
// THAT an agent failed, never aggregate WHY across runs.
//
// Every column is nullable and stays null for rows written before this
// migration. `tokens_*` also stay null for async/terminal providers — the
// model runs inside a Claude Code session this process never sees the token
// accounting for, so null means "not measurable here", not "zero". Those
// runs still get tool_calls/tool_errors, aggregated from the Claude Code
// hooks that already POST to /api/hook-events.
//
// `failure_class` is derived (see packages/agent-engine/src/failure-taxonomy.ts),
// never authored — it's the column the health panel and the retro agent
// group by. `agent_prompt_hash` is what lets a regression be pinned to a
// specific prompt edit instead of to the agent id in the abstract.
const COLUMNS: Array<[name: string, type: string]> = [
  ['duration_ms', 'INTEGER'],
  ['tokens_in', 'INTEGER'],
  ['tokens_out', 'INTEGER'],
  ['cache_read_tokens', 'INTEGER'],
  ['cache_creation_tokens', 'INTEGER'],
  ['iters', 'INTEGER'],
  ['tool_calls', 'INTEGER'],
  ['tool_errors', 'INTEGER'],
  ['failure_class', 'TEXT'],
  ['run_id', 'TEXT'],
  ['agent_prompt_hash', 'TEXT'],
]

const migration: Migration = {
  id: '045-execution-logs-telemetry',
  description: 'Add run telemetry columns to execution_logs (usage, tools, failure_class)',
  up(db) {
    const existing = new Set(
      (
        db.query(`SELECT name FROM pragma_table_info('execution_logs')`).all() as Array<{
          name: string
        }>
      ).map((r) => r.name),
    )
    for (const [name, type] of COLUMNS) {
      if (!existing.has(name)) db.run(`ALTER TABLE execution_logs ADD COLUMN ${name} ${type}`)
    }
    // The health panel groups by (agent, failure_class) over a time window,
    // and the retro agent scans failures only — both hit these two.
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_execution_logs_failure_class ON execution_logs(failure_class)`,
    )
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_execution_logs_agent_started ON execution_logs(agent_id, started_at)`,
    )
  },
}

export default migration
