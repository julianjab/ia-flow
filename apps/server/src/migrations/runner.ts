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

async function loadMigrations(): Promise<Migration[]> {
  const { default: m001 } = await import('./001-backlog-tagger-tools.js')
  const { default: m002 } = await import('./002-agents-tool-based.js')
  const { default: m003 } = await import('./003-implementer-progress-updates.js')
  const { default: m004 } = await import('./004-seed-default-scan-roots.js')
  return [m001, m002, m003, m004]
}

// ─── Legacy → new id map ─────────────────────────────────────────────────────
// After the renumber (drop of 001-agents-save-output and 003-agents-system-
// prompts-column, both folded into db.ts CREATE TABLE), we treat legacy ids as
// equivalent to the new ones so we never re-run a seed migration on a DB that
// already had it — that would overwrite user customizations to agent prompts.
const LEGACY_ID_MAP: Record<string, string> = {
  '002-backlog-tagger-tools': '001-backlog-tagger-tools',
  '005-agents-tool-based': '002-agents-tool-based',
  '006-implementer-progress-updates': '003-implementer-progress-updates',
  '007-seed-default-scan-roots': '004-seed-default-scan-roots',
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

  // Build set of "already applied" ids, following the legacy map so we don't
  // re-apply a migration that ran under its previous id. Stale rows are LEFT
  // in schema_migrations untouched — they are metadata only.
  const appliedRows = db.query('SELECT id FROM schema_migrations').all() as { id: string }[]
  const applied = new Set<string>()
  for (const { id } of appliedRows) {
    applied.add(id)
    const mapped = LEGACY_ID_MAP[id]
    if (mapped) applied.add(mapped)
  }

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue

    try {
      db.transaction(() => {
        migration.up(db)
        db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
          migration.id,
          new Date().toISOString(),
        ])
      })()
      log.info({ id: migration.id, description: migration.description }, 'Migration applied')
    } catch (err) {
      log.error({ id: migration.id, err }, 'Migration failed')
      throw err
    }
  }
}
