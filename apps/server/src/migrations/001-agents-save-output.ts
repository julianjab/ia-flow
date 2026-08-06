import type { Database } from 'bun:sqlite'
import type { Migration } from './runner.js'

const migration: Migration = {
  id: '001-agents-save-output',
  description: 'Add save_output column to agents table',
  up(db: Database): void {
    try {
      db.run('ALTER TABLE agents ADD COLUMN save_output INTEGER')
    } catch {
      // Column already exists — safe to ignore
    }
  },
}

export default migration
