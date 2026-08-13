import type { Migration } from './runner.js'

const migration: Migration = {
  id: '027-agents-requires-branch',
  description:
    'Add requires_branch column to agents (tri-state gate for engine auto-link branch; NULL=auto, 1=true, 0=false).',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'requires_branch')) {
      db.run('ALTER TABLE agents ADD COLUMN requires_branch INTEGER')
    }
  },
}

export default migration
