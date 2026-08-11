import type { Migration } from './runner.js'

const ENTRY_ID = 'github-mcp'
const ENTRY_NAME = 'GitHub MCP'
const ENTRY_DESCRIPTION =
  'Official GitHub MCP server (stdio, via npx). Requires GITHUB_PERSONAL_ACCESS_TOKEN.'
const ENTRY_CONFIG = {
  type: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
}

const migration: Migration = {
  id: '018-seed-github-mcp',
  description: 'Seed the GitHub MCP entry in mcp_catalog (idempotent)',
  up(db) {
    const existing = db.query('SELECT id FROM mcp_catalog WHERE id = ? LIMIT 1').get(ENTRY_ID) as {
      id: string
    } | null
    if (existing) return

    db.run(
      `INSERT INTO mcp_catalog (id, name, description, config, position)
       VALUES (?, ?, ?, ?, 0)`,
      [ENTRY_ID, ENTRY_NAME, ENTRY_DESCRIPTION, JSON.stringify(ENTRY_CONFIG)],
    )
  },
}

export default migration
