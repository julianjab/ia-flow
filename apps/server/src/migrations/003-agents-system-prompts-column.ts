import type { Database } from 'bun:sqlite'
import type { Migration } from './runner.js'

const migration: Migration = {
  id: '003-agents-system-prompts-column',
  description: 'Add system_prompts column to agents table',
  up(db: Database): void {
    try {
      db.run('ALTER TABLE agents ADD COLUMN system_prompts TEXT')
    } catch {
      // Column already exists — safe to ignore
    }
  },
}

export default migration
