import type { Migration } from './runner.js'

const migration: Migration = {
  id: '021-execution-logs',
  description: 'Create execution_logs table for agent run history',
  up(db) {
    db.run(`CREATE TABLE IF NOT EXISTS execution_logs (
      id          TEXT PRIMARY KEY NOT NULL,
      project_id  TEXT NOT NULL,
      task_id     TEXT NOT NULL,
      task_title  TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      outcome     TEXT,
      error_msg   TEXT,
      stop_reason TEXT
    )`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_execution_logs_project_id ON execution_logs(project_id)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_execution_logs_started_at ON execution_logs(started_at)`)
  },
}

export default migration
