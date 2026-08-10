import type { Migration } from './runner.js'

const migration: Migration = {
  id: '007-agents-provider-config',
  description: 'Add agents.provider_config (per-agent provider-specific blob)',
  up(db) {
    if (!hasColumn(db, 'agents', 'provider_config')) {
      db.run('ALTER TABLE agents ADD COLUMN provider_config TEXT')
    }
  },
}

function hasColumn(db: import('bun:sqlite').Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((r) => r.name === column)
}

export default migration
