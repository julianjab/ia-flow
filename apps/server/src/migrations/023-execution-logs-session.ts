import type { Migration } from './runner.js'

const migration: Migration = {
  id: '023-execution-logs-session',
  description: 'Track backing OS session (kind + id) per execution for cancel + watchdog',
  up(db) {
    db.run(`ALTER TABLE execution_logs ADD COLUMN session_kind TEXT`)
    db.run(`ALTER TABLE execution_logs ADD COLUMN session_id   TEXT`)
  },
}

export default migration
