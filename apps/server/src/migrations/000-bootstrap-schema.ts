import type { Migration } from './runner.js'

// Bootstrap schema — previously lived in db.ts getDb(). Moved here so all schema
// mutations are owned by migrations (single source of truth). All statements
// are idempotent (`IF NOT EXISTS`), so this is a no-op on existing DBs — the
// tables were already created at boot by the old bootstrap code.
//
// Migrations 001..005 assume these tables exist, so this runs first.

const migration: Migration = {
  id: '000-bootstrap-schema',
  description: 'Create baseline tables previously bootstrapped in db.ts',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS repos (
        name         TEXT PRIMARY KEY NOT NULL,
        path         TEXT,
        github_owner TEXT,
        github_repo  TEXT,
        workflow     TEXT
      )
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS project_settings (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )
    `)

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

    // `project_id` on agents/system_prompts is added by migration 005.
    db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id             TEXT PRIMARY KEY NOT NULL,
        position       INTEGER NOT NULL DEFAULT 0,
        provider       TEXT NOT NULL,
        prompt         TEXT NOT NULL,
        variables      TEXT,
        tools          TEXT,
        save_output    INTEGER,
        system_prompts TEXT
      )
    `)

    // On fresh DBs statuses is created with the composite PK directly. On pre-005
    // DBs the old shape already exists; migration 005 rebuilds it.
    db.run(`
      CREATE TABLE IF NOT EXISTS statuses (
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        position      INTEGER NOT NULL DEFAULT 0,
        context_repos TEXT,
        agents        TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (project_id, name)
      )
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS system_prompts (
        id       TEXT PRIMARY KEY NOT NULL,
        name     TEXT NOT NULL,
        text     TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      )
    `)

    db.run('DROP TABLE IF EXISTS repo_registry')
  },
}

export default migration
