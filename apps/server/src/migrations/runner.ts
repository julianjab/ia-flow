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
import m011 from './011-repos-per-project.js'
import m012 from './012-seed-repo-description-prompt.js'
import m013 from './013-strengthen-repo-description-prompt.js'
import m014 from './014-repo-description-with-tools.js'
import m015 from './015-seed-file-simplifier-prompt.js'
import m016 from './016-seed-history-compaction-prompt.js'
import m017 from './017-mcp-catalog.js'
import m018 from './018-seed-github-mcp.js'
import m019 from './019-statuses-allow-blocked.js'
import m020 from './020-agents-mcp-catalog-ids.js'
import m021 from './021-execution-logs.js'
import m022 from './022-agents-disabled-tools.js'
import m023 from './023-execution-logs-session.js'
import m024 from './024-internal-lifecycle-tools.js'
import m025 from './025-implementer-lifecycle-format.js'
import m026 from './026-refiners-set-repos.js'
import m027 from './027-agents-requires-branch.js'
import m028 from './028-implementer-push-remove-testers.js'
import m029 from './029-ia-flow-status-alignment.js'
import m030 from './030-cleanup-status-mismatch.js'
import m031 from './031-reviewers-sync-base-branch.js'
import m032 from './032-ia-flow-reviewer-no-pr-direct-merge.js'
import m033 from './033-lh116-ci-watcher.js'
import m034 from './034-build-label-cleanup.js'
import m035 from './035-agent-permissions.js'
import m036 from './036-agents-as-primary-entity.js'
import m037 from './037-agent-tools-unified.js'
import m038 from './038-agent-allow-blocked.js'
import m039 from './039-outcomes-labels-into-fields.js'
import m040 from './040-execution-logs-source.js'
import m041 from './041-agent-when-text.js'
import m042 from './042-provider-registrations.js'

const log = createLogger('migrations')

export interface Migration {
  id: string
  description: string
  up(db: Database): void
}

// ─── Registry — add new migrations here in order ──────────────────────────────

function loadMigrations(): Migration[] {
  return [
    m000,
    m001,
    m002,
    m003,
    m004,
    m005,
    m006,
    m007,
    m008,
    m009,
    m010,
    m011,
    m012,
    m013,
    m014,
    m015,
    m016,
    m017,
    m018,
    m019,
    m020,
    m021,
    m022,
    m023,
    m024,
    m025,
    m026,
    m027,
    m028,
    m029,
    m030,
    m031,
    m032,
    m033,
    m034,
    m035,
    m036,
    m037,
    m038,
    m039,
    m040,
    m041,
    m042,
  ]
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
