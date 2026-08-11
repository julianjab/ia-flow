import type { Migration } from './runner.js'

// Scopes repos per-project and adds a free-text `description` field.
//
// Design:
// - Every repo now belongs to exactly one project (`project_id NOT NULL`).
//   Global repos are gone; the projects UI is the single source of truth.
// - Composite primary key `(name, project_id)` — two projects may reuse the
//   same repo name (e.g. both have a repo called `backend`).
// - `description` is a free-text blurb about what the repo is, surfaced in
//   the UI and exposed to agents via `{{project.repos.*}}` template vars.
// - Backfill: existing rows are reparented to the oldest existing project,
//   mirroring the strategy in 005-projects-multi-tenant.
//
// SQLite can't drop a PK column, so we recreate the table and copy the data
// inside a single transaction (implicit — migrations already run inside one
// via the runner). ON DELETE CASCADE also lets us remove the manual
// `DELETE FROM repos WHERE project_id = ?` from SqliteProjectRepository.

const migration: Migration = {
  id: '011-repos-per-project',
  description: 'Scope repos per project (project_id NOT NULL) + add description column',
  up(db) {
    // Idempotence guard: if the new schema already exists, do nothing.
    const cols = db.query('PRAGMA table_info(repos)').all() as { name: string }[]
    if (cols.some((c) => c.name === 'project_id')) return

    const target = db.query('SELECT id FROM projects ORDER BY created_at ASC LIMIT 1').get() as {
      id: string
    } | null
    if (!target) {
      throw new Error(
        'Cannot run 011-repos-per-project: no rows in `projects`. Migration 005 seeds a default; ensure it ran.',
      )
    }
    const backfillId = target.id

    db.run(`
      CREATE TABLE repos_new (
        name         TEXT NOT NULL,
        path         TEXT,
        github_owner TEXT,
        github_repo  TEXT,
        workflow     TEXT,
        description  TEXT,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        PRIMARY KEY (name, project_id)
      )
    `)

    db.run(
      `INSERT INTO repos_new (name, path, github_owner, github_repo, workflow, project_id)
       SELECT name, path, github_owner, github_repo, workflow, ? FROM repos`,
      [backfillId],
    )

    db.run('DROP TABLE repos')
    db.run('ALTER TABLE repos_new RENAME TO repos')
    db.run('CREATE INDEX IF NOT EXISTS idx_repos_project_id ON repos(project_id)')
  },
}

export default migration
