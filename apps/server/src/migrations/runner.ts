import type { Database } from 'bun:sqlite'
import { getDb } from '../db.js'
import { createLogger } from '../logger.js'

const log = createLogger('migrations')

export interface Migration {
  id: string
  description: string
  up(db: Database): void
}

// ─── Registry — add new migrations here in order ──────────────────────────────

const MIGRATIONS: Migration[] = []

async function loadMigrations(): Promise<Migration[]> {
  const { default: m001 } = await import('./001-agents-save-output.js')
  const { default: m002 } = await import('./002-backlog-tagger-tools.js')
  return [m001, m002]
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runMigrations(): Promise<void> {
  const db = getDb()

  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)

  const migrations = await loadMigrations()

  for (const migration of migrations) {
    const already = db.query('SELECT id FROM schema_migrations WHERE id = ?').get(migration.id)
    if (already) continue

    try {
      db.transaction(() => {
        migration.up(db)
        db.run(
          'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
          [migration.id, new Date().toISOString()],
        )
      })()
      log.info({ id: migration.id, description: migration.description }, 'Migration applied')
    } catch (err) {
      log.error({ id: migration.id, err }, 'Migration failed')
      throw err
    }
  }
}
