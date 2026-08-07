import type { Migration } from './runner.js'

const migration: Migration = {
  id: '007-seed-default-scan-roots',
  description: 'Seed ~/development/lahaus/backend/python as the initial scan root',
  up(db) {
    const existing = db
      .query('SELECT value FROM project_settings WHERE key = ?')
      .get('scan_roots') as { value: string } | null
    if (existing) return
    db.run(`INSERT INTO project_settings (key, value) VALUES ('scan_roots', ?)`, [
      JSON.stringify(['~/development/lahaus/backend/python']),
    ])
  },
}

export default migration
