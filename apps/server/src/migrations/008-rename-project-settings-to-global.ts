import type { Migration } from './runner.js'

// Renames project_settings → global_settings and moves the two per-project
// keys (project.name, project.language) that were living in the K/V table
// into columns on the projects row:
//   - project.name     → projects.name          (already a column; only fill if empty)
//   - project.language → projects.language      (new column)
//
// The remaining K/V rows are machine-global (env vars, provider_config blob,
// scan_roots, …) and stay in the renamed table. This mirrors what the code
// already assumed — the K/V table never had a project_id column, so the two
// per-project keys were effectively single-tenant leftovers.
const migration: Migration = {
  id: '008-rename-project-settings-to-global',
  description:
    'Rename project_settings → global_settings and lift project.name/language onto projects row',
  up(db) {
    // Nothing to do if the table was already renamed by a prior partial run.
    const hasOld = (
      db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='project_settings'")
        .get() as { name: string } | null
    )?.name
    const hasNew = (
      db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='global_settings'")
        .get() as { name: string } | null
    )?.name

    if (!hasOld && !hasNew) {
      // Fresh install — create the table so the settings repo has somewhere to write.
      db.run(`
        CREATE TABLE IF NOT EXISTS global_settings (
          key   TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        )
      `)
    } else if (hasOld && !hasNew) {
      db.run('ALTER TABLE project_settings RENAME TO global_settings')
    }

    // Add projects.language column if missing.
    const projectCols = db.query('PRAGMA table_info(projects)').all() as { name: string }[]
    const hasLanguage = projectCols.some((c) => c.name === 'language')
    if (!hasLanguage) {
      db.run('ALTER TABLE projects ADD COLUMN language TEXT')
    }

    // Backfill: pick the oldest non-archived project as the target for the
    // pre-existing single-tenant keys. Silent no-op when the table is empty
    // or the keys don't exist.
    const target = db
      .query(
        'SELECT id, name FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC LIMIT 1',
      )
      .get() as { id: string; name: string } | null

    if (target) {
      const legacyName = (
        db.query("SELECT value FROM global_settings WHERE key = 'project.name'").get() as {
          value: string
        } | null
      )?.value
      const legacyLang = (
        db.query("SELECT value FROM global_settings WHERE key = 'project.language'").get() as {
          value: string
        } | null
      )?.value

      // Only overwrite name if the projects row is missing one (should never
      // happen given the NOT NULL constraint, but keep the guard).
      if (legacyName && (!target.name || target.name.trim() === '')) {
        db.run('UPDATE projects SET name = ? WHERE id = ?', [legacyName, target.id])
      }
      if (legacyLang) {
        db.run('UPDATE projects SET language = ? WHERE id = ?', [legacyLang, target.id])
      }
    }

    // Drop the legacy per-project keys — they now live on projects.
    db.run("DELETE FROM global_settings WHERE key IN ('project.name', 'project.language')")
  },
}

export default migration
