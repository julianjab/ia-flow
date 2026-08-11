import type { Migration } from './runner.js'

const migration: Migration = {
  id: '017-mcp-catalog',
  description: 'Create mcp_catalog table for shared MCP server definitions',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS mcp_catalog (
        id          TEXT PRIMARY KEY NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        config      TEXT NOT NULL,
        position    INTEGER NOT NULL DEFAULT 0
      )
    `)
  },
}

export default migration
