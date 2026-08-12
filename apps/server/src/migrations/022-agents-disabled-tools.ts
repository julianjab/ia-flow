import type { Migration } from './runner.js'

const migration: Migration = {
  id: '022-agents-disabled-tools',
  description:
    'Add disabled_tools column to agents for per-agent tool opt-out (write-tools epic #36)',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'disabled_tools')) {
      db.run('ALTER TABLE agents ADD COLUMN disabled_tools TEXT')
    }
  },
}

export default migration
