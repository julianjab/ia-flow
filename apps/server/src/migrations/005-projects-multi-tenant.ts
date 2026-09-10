import type { Migration } from './runner.js'

// Introduces multi-project support.
//
// Non-destructive: si esta migración corre sobre una DB que ya tenía agents/
// system_prompts/statuses de un único proyecto implícito (pre-multi-tenant),
// esas filas se reparentan al proyecto más antiguo que exista en `projects`
// — no se siembra ningún proyecto nuevo acá; eso es config de producto, no
// estructura, y vive en la UI (ver la regla de migraciones del CLAUDE.md
// de la raíz). En una DB nueva no hay nada que backfillear: `projects` queda
// vacía hasta que alguien cree uno.
//
// Design notes:
// - `agents.id` y `system_prompts.id` siguen siendo globalmente únicos (PK
//   simple en `id`). Overridear un agente global por proyecto = crear un
//   agente nuevo con otro id.
// - `statuses` cambia su PK a (project_id, name) para que proyectos
//   distintos puedan tener el mismo label de status (dos "Queued", por ej.).
// - `projects.settings` es un JSON blob libre para crecer knobs por proyecto
//   sin migraciones nuevas.

const migration: Migration = {
  id: '005-projects-multi-tenant',
  description: 'Add projects table + project_id on agents/statuses/system_prompts',
  up(db) {
    // ─── projects ────────────────────────────────────────────────────────
    db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id                 TEXT PRIMARY KEY NOT NULL,
        name               TEXT NOT NULL,
        github_project_url TEXT,
        settings           TEXT NOT NULL DEFAULT '{}',
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        archived_at        TEXT
      )
    `)

    // Pick the target project for backfills: el más antiguo que exista, o
    // `null` si `projects` está vacía (DB nueva, o ya sin nada que
    // backfillear). YA NO se inventa un id de fallback — un id que no existe
    // en `projects` dejaría filas huérfanas sin que nada lo detecte (no hay
    // `PRAGMA foreign_keys` prendido en este server).
    const target = db.query('SELECT id FROM projects ORDER BY created_at ASC LIMIT 1').get() as {
      id: string
    } | null
    const backfillId = target?.id ?? null

    // ─── agents.project_id (nullable = global) ───────────────────────────
    // Sin `target`, las filas existentes quedan en `project_id = NULL` — un
    // valor YA VÁLIDO (agente global), no un caso de error.
    if (!hasColumn(db, 'agents', 'project_id')) {
      db.run('ALTER TABLE agents ADD COLUMN project_id TEXT REFERENCES projects(id)')
      if (backfillId) {
        db.run('UPDATE agents SET project_id = ? WHERE project_id IS NULL', [backfillId])
      }
    }

    // ─── system_prompts.project_id (nullable = global) ───────────────────
    if (!hasColumn(db, 'system_prompts', 'project_id')) {
      db.run('ALTER TABLE system_prompts ADD COLUMN project_id TEXT REFERENCES projects(id)')
      if (backfillId) {
        db.run('UPDATE system_prompts SET project_id = ? WHERE project_id IS NULL', [backfillId])
      }
    }

    // ─── statuses: recreate with composite PK (project_id, name) ─────────
    // SQLite can't ALTER a PRIMARY KEY, so we rebuild the table. A diferencia
    // de agents/system_prompts, acá `project_id` es NOT NULL (no hay "status
    // global") — si hay filas reales que reparentar y no hay `target`, no
    // hay forma segura de continuar: mismo criterio que 011-repos-per-project.
    if (!hasColumn(db, 'statuses', 'project_id')) {
      const statusCount = (db.query('SELECT COUNT(*) AS c FROM statuses').get() as { c: number }).c
      if (statusCount > 0 && !backfillId) {
        throw new Error(
          'Cannot run 005-projects-multi-tenant: hay statuses para reparentar pero `projects` ' +
            'está vacía. Insertá un proyecto a mano antes de reintentar, ej.: ' +
            `INSERT INTO projects (id, name, settings, created_at, updated_at) VALUES ` +
            `('mi-proyecto', 'Mi proyecto', '{}', datetime('now'), datetime('now'));`,
        )
      }
      db.run(`
        CREATE TABLE statuses_new (
          project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name          TEXT NOT NULL,
          position      INTEGER NOT NULL DEFAULT 0,
          context_repos TEXT,
          agents        TEXT NOT NULL DEFAULT '[]',
          PRIMARY KEY (project_id, name)
        )
      `)
      db.run(
        `INSERT INTO statuses_new (project_id, name, position, context_repos, agents)
         SELECT ?, name, position, context_repos, agents FROM statuses`,
        [backfillId ?? ''],
      )
      db.run('DROP TABLE statuses')
      db.run('ALTER TABLE statuses_new RENAME TO statuses')
    }

    db.run('CREATE INDEX IF NOT EXISTS idx_agents_project_id ON agents(project_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_system_prompts_project_id ON system_prompts(project_id)')
  },
}

function hasColumn(db: import('bun:sqlite').Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((r) => r.name === column)
}

export default migration
