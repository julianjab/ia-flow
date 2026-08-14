// 035 — Migrate agents from tools[] / disabled_tools[] to permissions[] +
// preset_id (issue #58). Additive schema change: adds two columns and
// backfills them from the legacy fields. `disabled_tools` is NOT dropped
// here — the schema keeps it around during the transition window so
// in-flight AgentOrchestrator paths that still read it (and the DB row
// mapper in SqliteAgentRepository) don't stop working mid-deploy. A
// follow-up migration will drop the column once the code path is gone.
//
// Backfill rules (mirror `compilePolicy` semantics from the reverse
// direction — from a legacy tool list, derive the equivalent permissions):
//
//   - `read_file` / `list_dir` / `grep_files` → `fs.read`
//   - `write_file` / `edit_file`              → `fs.write`
//   - `update_issue_body` / `add_task_comment` / `set_task_field` /
//     `set_task_labels` / `mark_blocked_by`   → `task.write`
//   - `complete_task` / `fail_task`           → `task.transition`
//   - `reset_worktree`                        → `workspace`
//   - `run_command`                           → `bash:bun`, `bash:shell.generic`,
//                                                `bash:git.readonly`, `bash:git.write.task`
//                                                (matches the pre-issue-58 sandbox)
//
// Any tool the map doesn't cover (external / MCP catalog tools) is passed
// through as `tool:<name>` so the agent retains the exact same capability
// surface after the migration.
//
// When the derived permission set matches one of the built-in presets
// exactly, we set `preset_id` instead of listing the raw permissions —
// keeps the persisted representation compact and lets the UI render the
// dropdown selection out of the box.

import type { Migration } from './runner.js'

const TOOL_TO_PERMISSIONS: Record<string, string[]> = {
  read_file: ['fs.read'],
  list_dir: ['fs.read'],
  grep_files: ['fs.read'],
  write_file: ['fs.write'],
  edit_file: ['fs.write'],
  update_issue_body: ['task.write'],
  add_task_comment: ['task.write'],
  set_task_field: ['task.write'],
  set_task_labels: ['task.write'],
  mark_blocked_by: ['task.write'],
  complete_task: ['task.transition'],
  fail_task: ['task.transition'],
  reset_worktree: ['workspace'],
  run_command: ['bash:bun', 'bash:shell.generic', 'bash:git.readonly', 'bash:git.write.task'],
}

// (preset id, sorted permission list). Compared against the sorted derived
// list to detect a preset match. Kept inline (not imported from
// composition/permission-presets.ts) so this migration stays self-contained
// even if that file evolves.
const PRESET_SIGNATURES: Array<{ id: string; perms: string[] }> = [
  { id: 'reader', perms: ['fs.read', 'task.transition'] },
  { id: 'refiner', perms: ['fs.read', 'task.transition', 'task.write'] },
  {
    id: 'implementer',
    perms: [
      'bash:bun',
      'bash:git.readonly',
      'bash:git.write.task',
      'bash:shell.generic',
      'fs.read',
      'fs.write',
      'task.transition',
      'task.write',
      'workspace',
    ],
  },
  {
    id: 'reviewer',
    perms: [
      'bash:bun',
      'bash:gh',
      'bash:git.readonly',
      'bash:git.write.task',
      'bash:shell.generic',
      'fs.read',
      'fs.write',
      'task.transition',
      'task.write',
      'workspace',
    ],
  },
  {
    id: 'releaser',
    perms: [
      'bash:bun',
      'bash:gh',
      'bash:git.readonly',
      'bash:git.write.main',
      'bash:git.write.task',
      'bash:shell.generic',
      'fs.read',
      'fs.write',
      'task.transition',
      'task.write',
      'workspace',
    ],
  },
]

function derivePermissions(tools: string[], disabled: string[]): string[] {
  const disabledSet = new Set(disabled)
  const perms = new Set<string>()
  for (const t of tools) {
    if (disabledSet.has(t)) continue
    const mapped = TOOL_TO_PERMISSIONS[t]
    if (mapped) {
      for (const p of mapped) perms.add(p)
    } else {
      // Unknown tool — pass through as a tool: escape hatch. That preserves
      // the exact capability surface (MCP tools, adapter tools like the
      // GitHub tool cluster, custom tools) even though they don't fit the
      // built-in category taxonomy yet.
      perms.add(`tool:${t}`)
    }
  }
  return [...perms].sort()
}

function matchPreset(sortedPerms: string[]): string | null {
  const key = sortedPerms.join(',')
  for (const { id, perms } of PRESET_SIGNATURES) {
    if (perms.join(',') === key) return id
  }
  return null
}

const migration: Migration = {
  id: '035-agent-permissions',
  description:
    'Add permissions (JSON) + preset_id to agents and backfill from tools[]/disabled_tools[] (issue #58)',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as { name: string }[]
    const hasPermissions = cols.some((c) => c.name === 'permissions')
    const hasPresetId = cols.some((c) => c.name === 'preset_id')
    if (!hasPermissions) db.run('ALTER TABLE agents ADD COLUMN permissions TEXT')
    if (!hasPresetId) db.run('ALTER TABLE agents ADD COLUMN preset_id TEXT')

    // Backfill every row that does NOT yet have a permissions value set.
    // We do NOT overwrite rows the operator has already populated by hand
    // (e.g. via the CRUD endpoint post-035).
    const rows = db
      .query('SELECT id, tools, disabled_tools, permissions, preset_id FROM agents')
      .all() as Array<{
      id: string
      tools: string | null
      disabled_tools: string | null
      permissions: string | null
      preset_id: string | null
    }>

    for (const row of rows) {
      if (row.permissions || row.preset_id) continue
      const tools = row.tools ? (JSON.parse(row.tools) as string[]) : []
      const disabled = row.disabled_tools ? (JSON.parse(row.disabled_tools) as string[]) : []
      if (tools.length === 0) continue
      const derived = derivePermissions(tools, disabled)
      if (derived.length === 0) continue
      const preset = matchPreset(derived)
      // Also clear tools/disabled_tools on the same row — the provider now
      // treats `policy` as authoritative and ignores `tools[]` when the
      // agent opted into the DSL. Leaving the legacy columns populated
      // would be a footgun for anyone who reads the raw row and assumes
      // both are still in force (the DB shape stops matching the runtime
      // contract). See pre-push review finding #1.
      if (preset) {
        db.run(
          'UPDATE agents SET preset_id = ?, tools = NULL, disabled_tools = NULL WHERE id = ?',
          [preset, row.id],
        )
      } else {
        db.run(
          'UPDATE agents SET permissions = ?, tools = NULL, disabled_tools = NULL WHERE id = ?',
          [JSON.stringify(derived), row.id],
        )
      }
    }
  },
}

export default migration
