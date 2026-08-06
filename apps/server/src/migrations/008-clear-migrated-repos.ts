import type { Migration } from './runner.js'

const migration: Migration = {
  id: '008-clear-migrated-repos',
  description: 'Clear repos table populated by repo_registry migration — user registers repos manually via Settings',
  up(db) {
    db.run('DELETE FROM repos')
  },
}

export default migration
