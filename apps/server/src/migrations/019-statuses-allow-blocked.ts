import type { Migration } from './runner.js'

const migration: Migration = {
  id: '019-statuses-allow-blocked',
  description: 'Add allow_blocked column to statuses (per-status blocker gate opt-out)',
  up(db) {
    const cols = db.query('PRAGMA table_info(statuses)').all() as Array<{ name: string }>
    if (cols.some((c) => c.name === 'allow_blocked')) return
    db.run('ALTER TABLE statuses ADD COLUMN allow_blocked INTEGER NOT NULL DEFAULT 0')
  },
}

export default migration
