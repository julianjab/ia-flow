import type { Migration } from './runner.js'

// Introduces multi-project support.
//
// Non-destructive: existing rows are backfilled into the seeded `la-haus-116`
// project so the current single-tenant UI keeps rendering the same content.
// Users can later extract shared agents / prompts to the global scope (project_id
// = NULL) from the projects UI.
//
// Design notes:
// - `agents.id` and `system_prompts.id` remain globally unique (single PK on id).
//   Overriding a global agent per-project = create a new agent with a different id.
// - `statuses` PK changes to (project_id, name) so different projects can have
//   the same status label (e.g. two "Queued" columns).
// - `projects.settings` is a free-form JSON blob so we can grow per-project
//   knobs (concurrency, defaults, manager config) without further migrations.

const DEFAULT_PROJECT_ID = 'la-haus-116'
const DEFAULT_PROJECT_NAME = 'La Haus — Project 116'
const DEFAULT_PROJECT_URL = 'https://github.com/orgs/la-haus/projects/116'

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

    // Seed the default project (idempotent: skip if any project already exists).
    const projectCount = (db.query('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c
    if (projectCount === 0) {
      const now = new Date().toISOString()
      db.run(
        `INSERT INTO projects (id, name, github_project_url, settings, created_at, updated_at)
         VALUES (?, ?, ?, '{}', ?, ?)`,
        [DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_URL, now, now],
      )
    }

    // Pick the target project for backfills: seeded default, else the oldest row.
    const target = db.query('SELECT id FROM projects ORDER BY created_at ASC LIMIT 1').get() as {
      id: string
    } | null
    const backfillId = target?.id ?? DEFAULT_PROJECT_ID

    // ─── agents.project_id (nullable = global) ───────────────────────────
    if (!hasColumn(db, 'agents', 'project_id')) {
      db.run('ALTER TABLE agents ADD COLUMN project_id TEXT REFERENCES projects(id)')
      db.run('UPDATE agents SET project_id = ? WHERE project_id IS NULL', [backfillId])
    }

    // ─── system_prompts.project_id (nullable = global) ───────────────────
    if (!hasColumn(db, 'system_prompts', 'project_id')) {
      db.run('ALTER TABLE system_prompts ADD COLUMN project_id TEXT REFERENCES projects(id)')
      db.run('UPDATE system_prompts SET project_id = ? WHERE project_id IS NULL', [backfillId])
    }

    // ─── statuses: recreate with composite PK (project_id, name) ─────────
    // SQLite can't ALTER a PRIMARY KEY, so we rebuild the table. Existing rows
    // are copied and reparented to the default project.
    if (!hasColumn(db, 'statuses', 'project_id')) {
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
        [backfillId],
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
