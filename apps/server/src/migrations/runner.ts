import type { Database } from 'bun:sqlite'
import { createLogger } from '../logger.js'
import m000 from './000-bootstrap-schema.js'
import m001 from './001-backlog-tagger-tools.js'
import m002 from './002-agents-tool-based.js'
import m003 from './003-implementer-progress-updates.js'
import m004 from './004-seed-default-scan-roots.js'
import m005 from './005-projects-multi-tenant.js'
import m006 from './006-project-source.js'
import m007 from './007-agents-provider-config.js'
import m008 from './008-rename-project-settings-to-global.js'
import m009 from './009-unify-template-syntax.js'
import m010 from './010-rename-task-scoped-tools.js'

const log = createLogger('migrations')

export interface Migration {
  id: string
  description: string
  up(db: Database): void
}

// ─── Registry — add new migrations here in order ──────────────────────────────

function loadMigrations(): Migration[] {
  return [m000, m001, m002, m003, m004, m005, m006, m007, m008, m009, m010]
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

// Sync-safe entry point: `getDb()` calls this itself before returning the
// handle, so any caller — including module-level side effects like providers/
// index.ts seeding — sees a fully-migrated DB. `runMigrations` remains async
// for back-compat with the top-level `await runMigrations()` in index.ts.
export function runMigrationsSync(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)

  const migrations = loadMigrations()

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

// Kept async so the top-level `await runMigrations()` in index.ts still works
// without churning the bootstrap code. Callers that already hold a db handle
// (e.g. getDb()) should call `runMigrationsSync(db)` directly.
export async function runMigrations(): Promise<void> {
  const { getDb } = await import('../infrastructure/db/database.js')
  runMigrationsSync(getDb())
}
