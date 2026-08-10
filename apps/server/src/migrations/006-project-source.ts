import type { Migration } from './runner.js'

// Migrates projects from the single-purpose `github_project_url` column to a
// pluggable `source` shape stored as (source_kind TEXT, source_config JSON).
//
// Rows with github_project_url set → {kind:'github', config:{url}}.
// Rows without → {kind:'local'}.
// After backfill the old column is dropped: keeping both around invites
// drift, and the migration is easy to reason about only if there's exactly
// one source of truth.

const migration: Migration = {
  id: '006-project-source',
  description: 'Replace projects.github_project_url with (source_kind, source_config)',
  up(db) {
    if (!hasColumn(db, 'projects', 'source_kind')) {
      db.run('ALTER TABLE projects ADD COLUMN source_kind TEXT')
    }
    if (!hasColumn(db, 'projects', 'source_config')) {
      db.run('ALTER TABLE projects ADD COLUMN source_config TEXT')
    }

    // Backfill only rows we haven't touched yet (idempotent re-run safe).
    if (hasColumn(db, 'projects', 'github_project_url')) {
      db.run(
        `UPDATE projects
            SET source_kind = 'github',
                source_config = json_object('url', github_project_url)
          WHERE source_kind IS NULL
            AND github_project_url IS NOT NULL`,
      )
    }
    db.run(
      `UPDATE projects
          SET source_kind = 'local',
              source_config = '{}'
        WHERE source_kind IS NULL`,
    )

    // Drop the legacy column. Bun ships SQLite ≥ 3.35 so native DROP COLUMN
    // works; wrap in the has-column check to keep the migration re-runnable.
    if (hasColumn(db, 'projects', 'github_project_url')) {
      db.run('ALTER TABLE projects DROP COLUMN github_project_url')
    }
  },
}

function hasColumn(db: import('bun:sqlite').Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((r) => r.name === column)
}

export default migration
