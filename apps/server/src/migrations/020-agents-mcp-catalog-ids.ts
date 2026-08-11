import type { Migration } from './runner.js'

const migration: Migration = {
  id: '020-agents-mcp-catalog-ids',
  description: 'Add mcp_catalog_ids column to agents for referencing shared MCP catalog entries',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'mcp_catalog_ids')) {
      db.run('ALTER TABLE agents ADD COLUMN mcp_catalog_ids TEXT')
    }
  },
}

export default migration
