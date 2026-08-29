import type { Database } from 'bun:sqlite'
import { createLogger } from '../logger.js'
import m000 from './000-bootstrap-schema.js'
import m005 from './005-projects-multi-tenant.js'
import m006 from './006-project-source.js'
import m007 from './007-agents-provider-config.js'
import m008 from './008-rename-project-settings-to-global.js'
import m009 from './009-unify-template-syntax.js'
import m010 from './010-rename-task-scoped-tools.js'
import m011 from './011-repos-per-project.js'
import m017 from './017-mcp-catalog.js'
import m019 from './019-statuses-allow-blocked.js'
import m020 from './020-agents-mcp-catalog-ids.js'
import m021 from './021-execution-logs.js'
import m022 from './022-agents-disabled-tools.js'
import m023 from './023-execution-logs-session.js'
import m027 from './027-agents-requires-branch.js'
import m035 from './035-agent-permissions.js'
import m036 from './036-agents-as-primary-entity.js'
import m037 from './037-agent-tools-unified.js'
import m038 from './038-agent-allow-blocked.js'
import m039 from './039-outcomes-labels-into-fields.js'
import m040 from './040-execution-logs-source.js'
import m041 from './041-agent-when-text.js'
import m042 from './042-provider-registrations.js'
import m043 from './043-execution-logs-cancel-requested.js'
import m044 from './044-provider-registrations-drop-remote-provider-id.js'
import m045 from './045-execution-logs-telemetry.js'
import m046 from './046-backfill-execution-telemetry.js'
import m047 from './047-agent-max-concurrent-dispatches.js'
import m048 from './048-execution-logs-closing-contract.js'
import m049 from './049-execution-logs-finalized-by-tool.js'
import m050 from './050-outcomes-into-named-exits.js'
import m051 from './051-repo-slack-review.js'
import m052 from './052-repo-slack-review-channel-rename.js'
import m053 from './053-execution-logs-session-repair.js'
import m054 from './054-repo-slack-review-message.js'
import m055 from './055-agent-comment-target.js'
import m056 from './056-agent-memories.js'
import m057 from './057-execution-logs-assignees.js'
import m058 from './058-rules-and-actions.js'
import m059 from './059-activation-into-rules.js'
import m060 from './060-waits-and-run-messages.js'
import m061 from './061-seen-items.js'
import m062 from './062-rules-schedule.js'

const log = createLogger('migrations')

export interface Migration {
  id: string
  description: string
  up(db: Database): void
}

// ─── Registry — add new migrations here in order ──────────────────────────────
//
// La numeración tiene HUECOS a propósito: las migraciones que sembraban datos
// configurables (prompts de agentes, statuses, system prompts, la entrada del
// MCP de GitHub, los scan roots) se borraron — eso es config del operador, no
// esquema, y hacerlo nacer de una migración significaba que actualizar el
// producto reescribía lo que alguien había editado desde la UI. Los números
// borrados NO se reutilizan: una DB vieja los tiene en `schema_migrations` y
// reusarlos haría que se saltee la migración nueva.

function loadMigrations(): Migration[] {
  return [
    m000,
    m005,
    m006,
    m007,
    m008,
    m009,
    m010,
    m011,
    m017,
    m019,
    m020,
    m021,
    m022,
    m023,
    m027,
    m035,
    m036,
    m037,
    m038,
    m039,
    m040,
    m041,
    m042,
    m043,
    m044,
    m045,
    m046,
    m047,
    m048,
    m049,
    m050,
    m051,
    m052,
    m053,
    m054,
    m055,
    m056,
    m057,
    m058,
    m059,
    m060,
    m061,
    m062,
  ]
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

  // Las filas de migraciones que ya no existen en el registro se dejan
  // INTACTAS: son metadata, y borrarlas re-correría trabajo ya hecho el día que
  // un id se reutilice.
  const appliedRows = db.query('SELECT id FROM schema_migrations').all() as { id: string }[]
  const applied = new Set(appliedRows.map((r) => r.id))

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
