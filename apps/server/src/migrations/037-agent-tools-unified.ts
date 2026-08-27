// 037 — Collapse `tools[]` / `disabled_tools[]` / `permissions[]` / `preset_id`
// into a single `tools` column shaped as `AgentToolEntry[]` (see
// packages/shared/src/schemas.ts). Most tools are just their canonical name
// (string); `bash_run` is the one entry with its own config — `allow`/`deny`
// command patterns (prefix + `*` wildcard, same mental model as Claude
// Code's `Bash(cmd:*)` rules) instead of the old category/bash-sub-scope
// DSL from issue #58.
//
// By the time this runs, migration 035 has already converted virtually every
// row to `permissions[]`/`preset_id` and nulled out `tools`/`disabled_tools`
// — this migration's legacy-tools branch below only exists to catch any row
// that somehow skipped that pass (e.g. a hand-edited DB row).
//
// The category/bash-scope → tools[]+patterns mapping here is a best-effort
// equivalent, not a byte-for-byte behavioral mirror: the old `assertGitSafe`
// classified individual git subcommands (readonly/write/destructive) with
// bespoke logic that has no exact pattern-list equivalent. Operators should
// review migrated `bash_run` agents in the UI and tighten `allow`/`deny` if
// the defaults below are broader than they want.

import type { Migration } from './runner.js'

type ToolEntry = string | { name: 'bash_run'; allow: string[]; deny: string[] }

// ─── Legacy tool alias → canonical name (only fs_* / bash_run / workspace_reset
// were ever renamed; task/github/slack tools already use their canonical id).
const ALIAS_TO_CANONICAL: Record<string, string> = {
  read_file: 'fs_read',
  list_dir: 'fs_list',
  grep_files: 'fs_grep',
  write_file: 'fs_write',
  edit_file: 'fs_edit',
  reset_worktree: 'workspace_reset',
  run_command: 'bash_run',
}

// ─── Category → canonical tool names (mirrors the pre-037 getToolsByCategory
// grouping, inlined so this migration stays self-contained).
const CATEGORY_TOOLS: Record<string, string[]> = {
  'fs.read': ['fs_read', 'fs_list', 'fs_grep'],
  'fs.write': ['fs_write', 'fs_edit'],
  'task.write': [
    'update_issue_body',
    'add_task_comment',
    'set_task_field',
    'set_task_labels',
    'mark_blocked_by',
  ],
  'task.transition': ['complete_task', 'fail_task'],
  workspace: ['workspace_reset'],
}

const BASH_SCOPE_ALLOW: Record<string, string[]> = {
  bun: ['bun *', 'bunx *', 'npm *', 'pnpm *', 'node *'],
  'shell.generic': [
    'cat *',
    'ls',
    'ls *',
    'head *',
    'tail *',
    'find *',
    'rg *',
    'make *',
    'go *',
    'uv *',
    'pytest',
    'pytest *',
    'ruff *',
  ],
  'git.readonly': [
    'git status',
    'git status *',
    'git log',
    'git log *',
    'git diff',
    'git diff *',
    'git show *',
    'git fetch',
    'git fetch *',
    'git ls-files *',
    'git blame *',
    'git rev-parse *',
  ],
  'git.write.task': ['git add *', 'git commit *', 'git push', 'git push *'],
  'git.write.main': [], // handled specially (see expandBash) — removes the main/release deny instead of adding an allow
  'git.destructive': [
    'git reset --hard*',
    'git branch -D *',
    'git branch -d *',
    'git checkout *',
    'git switch *',
    'git worktree remove *',
  ],
  gh: ['gh pr *', 'gh issue *', 'gh label *', 'gh search *', 'gh browse *', 'gh status'],
}

const MAIN_PUSH_DENY = [
  'git push origin main',
  'git push origin main *',
  'git push -u origin main',
  'git push -u origin main *',
  'git push origin release/*',
]

function expandBash(scopes: Set<string>): { name: 'bash_run'; allow: string[]; deny: string[] } {
  const allow = new Set<string>()
  for (const scope of scopes) {
    for (const p of BASH_SCOPE_ALLOW[scope] ?? []) allow.add(p)
  }
  const deny = scopes.has('git.write.main') ? [] : [...MAIN_PUSH_DENY]
  return { name: 'bash_run', allow: [...allow], deny }
}

function toolsFromPermissions(permissions: string[]): ToolEntry[] {
  const tools = new Set<string>()
  const bashScopes = new Set<string>()
  let hasBash = false

  for (const perm of permissions) {
    if (perm === 'bash') {
      hasBash = true
      bashScopes.add('shell.generic')
      bashScopes.add('bun')
      bashScopes.add('git.readonly')
      bashScopes.add('git.write.task')
      continue
    }
    if (perm.startsWith('bash:')) {
      hasBash = true
      bashScopes.add(perm.slice('bash:'.length))
      continue
    }
    if (perm.startsWith('tool:')) {
      tools.add(perm.slice('tool:'.length))
      continue
    }
    for (const t of CATEGORY_TOOLS[perm] ?? []) tools.add(t)
  }

  const out: ToolEntry[] = [...tools]
  if (hasBash) out.push(expandBash(bashScopes))
  return out
}

function toolsFromLegacy(names: string[], disabled: string[]): ToolEntry[] {
  const disabledSet = new Set(disabled)
  const tools = new Set<string>()
  let hasBash = false
  for (const raw of names) {
    if (disabledSet.has(raw)) continue
    const canonical = ALIAS_TO_CANONICAL[raw] ?? raw
    if (canonical === 'bash_run') {
      hasBash = true
      continue
    }
    tools.add(canonical)
  }
  const out: ToolEntry[] = [...tools]
  if (hasBash) {
    // Legacy `run_command` mirrored the pre-issue-58 sandbox: bun + generic
    // shell utils + git readonly/task-push, never main, never gh.
    out.push(expandBash(new Set(['bun', 'shell.generic', 'git.readonly', 'git.write.task'])))
  }
  return out
}

const PRESET_PERMISSIONS: Record<string, string[]> = {
  reader: ['fs.read', 'task.transition'],
  refiner: ['fs.read', 'task.write', 'task.transition'],
  implementer: [
    'fs.read',
    'fs.write',
    'task.write',
    'task.transition',
    'workspace',
    'bash:bun',
    'bash:shell.generic',
    'bash:git.readonly',
    'bash:git.write.task',
  ],
  reviewer: [
    'fs.read',
    'fs.write',
    'task.write',
    'task.transition',
    'workspace',
    'bash:bun',
    'bash:shell.generic',
    'bash:git.readonly',
    'bash:git.write.task',
    'bash:gh',
  ],
  releaser: [
    'fs.read',
    'fs.write',
    'task.write',
    'task.transition',
    'workspace',
    'bash:bun',
    'bash:shell.generic',
    'bash:git.readonly',
    'bash:git.write.task',
    'bash:gh',
    'bash:git.write.main',
  ],
}

const migration: Migration = {
  id: '037-agent-tools-unified',
  description:
    'Collapse tools[]/disabled_tools[]/permissions[]/preset_id into a single tools column (AgentToolEntry[])',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as { name: string }[]
    const hasPermissions = cols.some((c) => c.name === 'permissions')
    // Already migrated (or a fresh DB created after this migration existed,
    // where 000-bootstrap-schema's plain `tools TEXT` column already matches
    // the new shape) — nothing to do.
    if (!hasPermissions) return

    const rows = db
      .query('SELECT id, tools, disabled_tools, permissions, preset_id FROM agents')
      .all() as Array<{
      id: string
      tools: string | null
      disabled_tools: string | null
      permissions: string | null
      preset_id: string | null
    }>

    const newTools = new Map<string, ToolEntry[]>()
    for (const row of rows) {
      const presetPerms = row.preset_id ? (PRESET_PERMISSIONS[row.preset_id] ?? []) : []
      const explicitPerms = row.permissions ? (JSON.parse(row.permissions) as string[]) : []
      if (presetPerms.length || explicitPerms.length) {
        newTools.set(row.id, toolsFromPermissions([...presetPerms, ...explicitPerms]))
        continue
      }
      const legacyTools = row.tools ? (JSON.parse(row.tools) as string[]) : []
      const legacyDisabled = row.disabled_tools ? (JSON.parse(row.disabled_tools) as string[]) : []
      if (legacyTools.length) {
        console.log(
          `[037-agent-tools-unified] agent "${row.id}" had leftover legacy tools[] (not migrated by 035) — converting directly`,
        )
        newTools.set(row.id, toolsFromLegacy(legacyTools, legacyDisabled))
        continue
      }
      newTools.set(row.id, [])
    }

    db.run('ALTER TABLE agents ADD COLUMN tools_v2 TEXT')
    const update = db.query('UPDATE agents SET tools_v2 = ? WHERE id = ?')
    for (const [id, entries] of newTools) {
      update.run(entries.length ? JSON.stringify(entries) : null, id)
    }

    // Recreate `agents` without disabled_tools/permissions/preset_id, with
    // tools_v2 renamed to tools. SQLite's ALTER TABLE can't drop columns on
    // the versions we target, so the table is recreated (same pattern as
    // 011-repos-per-project / 036-agents-as-primary-entity).
    db.run(`
      CREATE TABLE agents_new (
        id                 TEXT PRIMARY KEY NOT NULL,
        position           INTEGER NOT NULL DEFAULT 0,
        provider           TEXT NOT NULL,
        prompt             TEXT NOT NULL,
        variables          TEXT,
        tools              TEXT,
        save_output        INTEGER,
        system_prompts     TEXT,
        project_id         TEXT REFERENCES projects(id),
        provider_config    TEXT,
        mcp_catalog_ids    TEXT,
        requires_branch    INTEGER,
        repo_name          TEXT,
        status_name        TEXT,
        when_conditions    TEXT,
        on_process         TEXT,
        on_finish          TEXT,
        on_error           TEXT,
        on_process_labels  TEXT,
        on_finish_labels   TEXT,
        on_error_labels    TEXT,
        enabled            INTEGER NOT NULL DEFAULT 1,
        comment            TEXT
      )
    `)
    db.run(`
      INSERT INTO agents_new (
        id, position, provider, prompt, variables, tools, save_output, system_prompts,
        project_id, provider_config, mcp_catalog_ids, requires_branch, repo_name, status_name,
        when_conditions, on_process, on_finish, on_error, on_process_labels, on_finish_labels,
        on_error_labels, enabled
      )
      SELECT
        id, position, provider, prompt, variables, tools_v2, save_output, system_prompts,
        project_id, provider_config, mcp_catalog_ids, requires_branch, repo_name, status_name,
        when_conditions, on_process, on_finish, on_error, on_process_labels, on_finish_labels,
        on_error_labels, enabled
      FROM agents
    `)
    db.run('DROP TABLE agents')
    db.run('ALTER TABLE agents_new RENAME TO agents')
  },
}

export default migration
