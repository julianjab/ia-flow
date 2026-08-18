import type { Migration } from './runner.js'

// Inverts the activation model: today `statuses.agents` (a JSON array of
// `StatusAgentEntry`) decides which agents run on each status — the status
// is the primary entity and the agent is just a name inside its list. From
// this migration on, the AGENT is the primary entity: it carries its own
// activation criteria (`repo_name`, `status_name`, `when_conditions`) and the
// engine asks "which agents match this repo+status?" instead of "which
// agents does this status list?".
//
// Step 1 — new columns on `agents`:
//   - `repo_name`   — NULL = matches every repo in the agent's project.
//   - `status_name` — NULL = matches every status in the agent's project.
//     `repo_name` is a LOGICAL reference to `repos.name`, resolved by the
//     engine against the agent's own `project_id` at match time — it is NOT
//     a SQL foreign key. `repos` has a composite PK `(name, project_id)`, so
//     a bare `repo_name` FK can't target it unambiguously; the engine already
//     knows the project it's dispatching in, so the join happens in code.
//   - `when_conditions`   — JSON `WhenCondition[]`, mirrors the legacy
//     `StatusAgentEntry.when` (array form only; the legacy flat-record form
//     is normalized to an array during backfill below).
//   - `on_process` / `on_finish` / `on_error` — outcome `$set:` strings,
//     mirrors `StatusAgentEntry.onProcess/onFinish/onError`.
//   - `on_process_labels` / `on_finish_labels` / `on_error_labels` —
//     `$labels:` outcome strings, mirrors the matching `StatusAgentEntry`
//     fields.
//   - `enabled` — defaults to 1 (on) for every existing row, so pre-migration
//     agents keep running once wired to their inherited status/repo. Rows
//     backfilled as "never referenced by any status" (see step 2, last
//     block) are explicitly flipped to 0 — see the comment there for why.
//
// Step 2 — backfill from `statuses.agents`, oldest project/status/position
// first. Each `StatusAgentEntry` becomes either an UPDATE on the referenced
// agent row (first time that agent id is seen) or a CLONE of it (every
// subsequent time — the same agent wired to more than one status can't share
// a single `status_name` column, so it gets its own row per extra wiring).
// The processing order becomes the new `agents.position`, which is what the
// engine will use to pick "the first agent that matches" for a given
// repo+status.
//
// Step 3 — `statuses.agents` is dropped. SQLite can't DROP COLUMN on a table
// with a composite PK in the versions we target, so the table is recreated
// (same pattern as 011-repos-per-project).

import type { Database } from 'bun:sqlite'

interface WhenCondition {
  field: string
  op: string
  value?: string
  logic?: 'and' | 'or'
}

interface StatusAgentEntry {
  agent: string
  when?: WhenCondition[] | Record<string, string>
  onProcess?: string
  onFinish?: string
  onError?: string
  onProcessLabels?: string
  onFinishLabels?: string
  onErrorLabels?: string
}

interface AgentDefRow {
  id: string
  position: number
  provider: string
  prompt: string
  variables: string | null
  tools: string | null
  save_output: number | null
  system_prompts: string | null
  project_id: string | null
  provider_config: string | null
  mcp_catalog_ids: string | null
  disabled_tools: string | null
  requires_branch: number | null
  permissions: string | null
  preset_id: string | null
}

const DEF_COLUMNS = [
  'provider',
  'prompt',
  'variables',
  'tools',
  'save_output',
  'system_prompts',
  'project_id',
  'provider_config',
  'mcp_catalog_ids',
  'disabled_tools',
  'requires_branch',
  'permissions',
  'preset_id',
] as const

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeWhen(when: StatusAgentEntry['when']): WhenCondition[] | null {
  if (!when) return null
  if (Array.isArray(when)) {
    return when.length > 0 ? when : null
  }
  // Legacy flat-record form: every entry is an implicit `equals`, all AND'd.
  const entries = Object.entries(when)
  if (entries.length === 0) return null
  return entries.map(([field, value]) => ({ field, op: 'equals', value, logic: 'and' }))
}

function uniqueId(db: Database, baseId: string): string {
  const exists = (id: string) =>
    (db.query('SELECT 1 FROM agents WHERE id = ?').get(id) as unknown) != null
  if (!exists(baseId)) return baseId
  let n = 2
  while (exists(`${baseId}-${n}`)) n++
  return `${baseId}-${n}`
}

const migration: Migration = {
  id: '036-agents-as-primary-entity',
  description:
    'Agents become the primary entity: add repo_name/status_name/when/outcome columns, backfill from statuses.agents, drop statuses.agents',
  up(db) {
    // Idempotence guard: if the new columns already exist, do nothing.
    const cols = db.query('PRAGMA table_info(agents)').all() as { name: string }[]
    if (cols.some((c) => c.name === 'status_name')) return

    db.run('ALTER TABLE agents ADD COLUMN repo_name TEXT')
    db.run('ALTER TABLE agents ADD COLUMN status_name TEXT')
    db.run('ALTER TABLE agents ADD COLUMN when_conditions TEXT')
    db.run('ALTER TABLE agents ADD COLUMN on_process TEXT')
    db.run('ALTER TABLE agents ADD COLUMN on_finish TEXT')
    db.run('ALTER TABLE agents ADD COLUMN on_error TEXT')
    db.run('ALTER TABLE agents ADD COLUMN on_process_labels TEXT')
    db.run('ALTER TABLE agents ADD COLUMN on_finish_labels TEXT')
    db.run('ALTER TABLE agents ADD COLUMN on_error_labels TEXT')
    db.run('ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')

    // ─── Step 2 — backfill from statuses.agents ───────────────────────────

    const statusRows = db
      .query(
        'SELECT project_id, name, position, agents FROM statuses ORDER BY project_id, position ASC',
      )
      .all() as Array<{ project_id: string; name: string; position: number; agents: string }>

    let seq = 0
    const seen = new Set<string>()

    for (const status of statusRows) {
      let entries: StatusAgentEntry[]
      try {
        entries = JSON.parse(status.agents) as StatusAgentEntry[]
      } catch {
        continue
      }
      if (!Array.isArray(entries)) continue

      for (const entry of entries) {
        const originalId = entry.agent
        const original = db
          .query('SELECT * FROM agents WHERE id = ?')
          .get(originalId) as AgentDefRow | null
        if (!original) {
          console.log(
            `[036-agents-as-primary-entity] skipping orphan entry: agent "${originalId}" referenced by status "${status.name}" (project ${status.project_id}) does not exist`,
          )
          continue
        }

        const whenConditions = normalizeWhen(entry.when)
        const position = seq
        seq++

        if (!seen.has(originalId)) {
          seen.add(originalId)
          db.run(
            `UPDATE agents SET
               status_name = ?,
               when_conditions = ?,
               on_process = ?,
               on_finish = ?,
               on_error = ?,
               on_process_labels = ?,
               on_finish_labels = ?,
               on_error_labels = ?,
               position = ?,
               enabled = 1
             WHERE id = ?`,
            [
              status.name,
              whenConditions ? JSON.stringify(whenConditions) : null,
              entry.onProcess ?? null,
              entry.onFinish ?? null,
              entry.onError ?? null,
              entry.onProcessLabels ?? null,
              entry.onFinishLabels ?? null,
              entry.onErrorLabels ?? null,
              position,
              originalId,
            ],
          )
        } else {
          // Same agent already wired to a previous status — status_name is a
          // single column, so this extra wiring can't live on the same row.
          // Clone the row's definition columns into a new agent id and give
          // the clone this entry's activation criteria.
          const cloneBaseId = `${originalId}--${slugify(status.name)}`
          const cloneId = uniqueId(db, cloneBaseId)

          const cols = DEF_COLUMNS.join(', ')
          const placeholders = DEF_COLUMNS.map(() => '?').join(', ')
          const values = DEF_COLUMNS.map((c) => original[c as keyof AgentDefRow])

          db.run(
            `INSERT INTO agents (
               id, ${cols},
               status_name, when_conditions,
               on_process, on_finish, on_error,
               on_process_labels, on_finish_labels, on_error_labels,
               position, enabled
             ) VALUES (?, ${placeholders}, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
              cloneId,
              ...values,
              status.name,
              whenConditions ? JSON.stringify(whenConditions) : null,
              entry.onProcess ?? null,
              entry.onFinish ?? null,
              entry.onError ?? null,
              entry.onProcessLabels ?? null,
              entry.onFinishLabels ?? null,
              entry.onErrorLabels ?? null,
              position,
            ],
          )

          console.log(
            `[036-agents-as-primary-entity] cloned agent "${originalId}" -> "${cloneId}" for status "${status.name}" (project ${status.project_id})`,
          )
        }
      }
    }

    // Agents that were never referenced by any status kept the pre-migration
    // schema's actual behavior: a status decides who runs, so an agent not
    // listed anywhere never ran. Now that `status_name = NULL` means "matches
    // every status", leaving these rows untouched would make them start
    // running everywhere — a behavior change this migration must NOT
    // introduce. So they're explicitly disabled (`enabled = 0`) instead,
    // preserving "never runs" until an operator opts them in deliberately.
    // They still get consecutive positions, continuing after every migrated
    // row, so their relative order (definition order) is stable once enabled.
    const unreferenced = db
      .query('SELECT id FROM agents WHERE status_name IS NULL ORDER BY id')
      .all() as Array<{ id: string }>

    for (const row of unreferenced) {
      db.run('UPDATE agents SET enabled = 0, position = ? WHERE id = ?', [seq, row.id])
      seq++
    }

    // ─── Step 3 — drop statuses.agents ─────────────────────────────────────

    const statusCols = db.query('PRAGMA table_info(statuses)').all() as { name: string }[]
    const hasAllowBlocked = statusCols.some((c) => c.name === 'allow_blocked')

    db.run(`
      CREATE TABLE statuses_new (
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        position      INTEGER NOT NULL DEFAULT 0,
        context_repos TEXT,
        allow_blocked INTEGER,
        PRIMARY KEY (project_id, name)
      )
    `)

    if (hasAllowBlocked) {
      db.run(`
        INSERT INTO statuses_new (project_id, name, position, context_repos, allow_blocked)
        SELECT project_id, name, position, context_repos, allow_blocked FROM statuses
      `)
    } else {
      db.run(`
        INSERT INTO statuses_new (project_id, name, position, context_repos)
        SELECT project_id, name, position, context_repos FROM statuses
      `)
    }

    db.run('DROP TABLE statuses')
    db.run('ALTER TABLE statuses_new RENAME TO statuses')
  },
}

export default migration
