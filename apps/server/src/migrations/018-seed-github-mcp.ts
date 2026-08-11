import type { Migration } from './runner.js'

const ENTRY_ID = 'github-mcp'
const ENTRY_NAME = 'GitHub MCP'
const ENTRY_DESCRIPTION =
  'Official GitHub remote MCP server (https). Usa el env var GITHUB_TOKEN ya configurado en ia-flow.'
const ENTRY_CONFIG = {
  type: 'http' as const,
  url: 'https://api.githubcopilot.com/mcp/',
  authorizationToken: '${GITHUB_TOKEN}',
}

// Bumped id to force re-run on existing DBs after switching from stdio (npx)
// to the remote http endpoint. Body upserts (DELETE + INSERT) so both fresh
// installs and DBs already carrying the old stdio config end up on the new one.
const migration: Migration = {
  id: '018-seed-github-mcp-v3',
  description: 'Seed / re-seed the GitHub MCP entry using the remote http endpoint',
  up(db) {
    db.run('DELETE FROM mcp_catalog WHERE id = ?', [ENTRY_ID])
    db.run(
      `INSERT INTO mcp_catalog (id, name, description, config, position)
       VALUES (?, ?, ?, ?, 0)`,
      [ENTRY_ID, ENTRY_NAME, ENTRY_DESCRIPTION, JSON.stringify(ENTRY_CONFIG)],
    )
  },
}

export default migration
