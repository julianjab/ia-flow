// Unit test for migration 035 — asserts the tools[]/disabled_tools[] →
// permissions[]/preset_id backfill lands the expected values on a set of
// synthetic rows that mirror the shapes we know live in production
// (reader-ish, implementer-ish, one with an unmapped MCP tool, and one
// already-migrated row that must not be overwritten).

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import m035 from './035-agent-permissions.js'

function makeDb(): Database {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE agents (
      id             TEXT PRIMARY KEY,
      position       INTEGER,
      provider       TEXT,
      prompt         TEXT,
      variables      TEXT,
      tools          TEXT,
      disabled_tools TEXT,
      system_prompts TEXT,
      save_output    INTEGER,
      provider_config TEXT,
      mcp_catalog_ids TEXT,
      project_id     TEXT,
      requires_branch INTEGER
    )
  `)
  return db
}

function insertAgent(db: Database, id: string, tools: string[], disabled?: string[]) {
  db.run(
    'INSERT INTO agents (id, position, provider, prompt, tools, disabled_tools) VALUES (?, 0, ?, ?, ?, ?)',
    [id, 'anthropic-api', 'p', JSON.stringify(tools), disabled ? JSON.stringify(disabled) : null],
  )
}

describe('migration 035-agent-permissions', () => {
  it('adds permissions + preset_id columns', () => {
    const db = makeDb()
    m035.up(db)
    const cols = (db.query('PRAGMA table_info(agents)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(cols).toContain('permissions')
    expect(cols).toContain('preset_id')
  })

  it('picks the implementer preset when the tool set matches exactly', () => {
    const db = makeDb()
    insertAgent(db, 'impl', [
      'read_file',
      'list_dir',
      'grep_files',
      'write_file',
      'edit_file',
      'reset_worktree',
      'run_command',
      'complete_task',
      'fail_task',
      'update_issue_body',
      'add_task_comment',
    ])
    m035.up(db)
    const row = db.query('SELECT permissions, preset_id FROM agents WHERE id = ?').get('impl') as {
      permissions: string | null
      preset_id: string | null
    }
    expect(row.preset_id).toBe('implementer')
    expect(row.permissions).toBeNull()
  })

  it('picks the reader preset for read-only tool sets', () => {
    const db = makeDb()
    insertAgent(db, 'r', ['read_file', 'list_dir', 'grep_files', 'complete_task', 'fail_task'])
    m035.up(db)
    const row = db.query('SELECT preset_id FROM agents WHERE id = ?').get('r') as {
      preset_id: string | null
    }
    expect(row.preset_id).toBe('reader')
  })

  it('falls back to raw permissions[] when the derived set matches no preset', () => {
    const db = makeDb()
    insertAgent(db, 'weird', ['read_file', 'update_issue_body'])
    m035.up(db)
    const row = db.query('SELECT permissions, preset_id FROM agents WHERE id = ?').get('weird') as {
      permissions: string | null
      preset_id: string | null
    }
    expect(row.preset_id).toBeNull()
    expect(JSON.parse(row.permissions!)).toEqual(['fs.read', 'task.write'])
  })

  it('honors disabled_tools when deriving permissions', () => {
    const db = makeDb()
    // Agent had run_command + write_file, but disabled_tools removed
    // write_file → no fs.write in the derived set.
    insertAgent(db, 'restricted', ['read_file', 'write_file'], ['write_file'])
    m035.up(db)
    const row = db
      .query('SELECT permissions, preset_id FROM agents WHERE id = ?')
      .get('restricted') as { permissions: string | null; preset_id: string | null }
    expect(row.permissions).toBe(JSON.stringify(['fs.read']))
  })

  it('clears tools / disabled_tools after migrating a row (policy is authoritative)', () => {
    const db = makeDb()
    insertAgent(db, 'r', ['read_file', 'complete_task', 'fail_task'])
    m035.up(db)
    const row = db.query('SELECT tools, disabled_tools FROM agents WHERE id = ?').get('r') as {
      tools: string | null
      disabled_tools: string | null
    }
    expect(row.tools).toBeNull()
    expect(row.disabled_tools).toBeNull()
  })

  it('passes unknown tools through as tool:<name>', () => {
    const db = makeDb()
    insertAgent(db, 'mcp', ['read_file', 'github__create_pr'])
    m035.up(db)
    const row = db.query('SELECT permissions FROM agents WHERE id = ?').get('mcp') as {
      permissions: string | null
    }
    expect(JSON.parse(row.permissions!)).toEqual(['fs.read', 'tool:github__create_pr'])
  })

  it('does NOT overwrite a row that already has permissions or preset_id', () => {
    const db = makeDb()
    m035.up(db) // add columns first so INSERT below can set them
    db.run(
      "INSERT INTO agents (id, position, provider, prompt, tools, preset_id) VALUES ('pre-migrated', 0, 'anthropic-api', 'p', ?, 'reviewer')",
      [JSON.stringify(['read_file'])],
    )
    m035.up(db) // second pass — must not touch this row
    const row = db.query('SELECT preset_id FROM agents WHERE id = ?').get('pre-migrated') as {
      preset_id: string | null
    }
    expect(row.preset_id).toBe('reviewer')
  })

  it('is idempotent', () => {
    const db = makeDb()
    insertAgent(db, 'r', ['read_file', 'complete_task', 'fail_task'])
    m035.up(db)
    m035.up(db)
    m035.up(db)
    const cols = (db.query('PRAGMA table_info(agents)').all() as { name: string }[])
      .map((c) => c.name)
      .filter((n) => n === 'permissions' || n === 'preset_id')
    // Ensure we didn't try to add the columns twice.
    expect(cols).toEqual(['permissions', 'preset_id'])
  })
})
