// Policy compiler — expands the declarative Permission[] language (see
// packages/shared/src/schemas.ts::PermissionSchema and issue #58) into the
// runtime sandbox shape the tools + exec layers consume.
//
// The compiler is pure: give it a list of permissions (+ optional preset)
// and get back a CompiledPolicy. AgentOrchestrator calls it once per
// dispatch and threads the result through ProviderInput → ToolContext, so
// tools never re-parse permission strings.

import type { Permission, PermissionPresetId, ToolCategory } from '@ia-flow/shared'
import type { CompiledPolicy } from './contract.js'
import { getToolsByCategory, resolveAliases } from './engine.js'
import { ALL_PRESETS, PRESET_BY_ID, type PermissionPresetDef } from './permission-presets.js'

// ─── Static maps ──────────────────────────────────────────────────────────
// Which bins belong to which sub-scope. `bash:<scope>` opts into all of
// them; the `bash` category (no sub-scope) opts into everything under
// `shell.generic` + `bun` + `git.readonly` (the historical default).

const BASH_SCOPE_BINS: Record<string, readonly string[]> = {
  bun: ['bun', 'bunx', 'node', 'npm', 'pnpm'],
  gh: ['gh'],
  'git.readonly': ['git'],
  'git.write.task': ['git'],
  'git.write.main': ['git'],
  'git.destructive': ['git'],
  'shell.generic': [
    'cat',
    'ls',
    'head',
    'tail',
    'find',
    'rg',
    'make',
    'go',
    'uv',
    'pytest',
    'ruff',
  ],
}

/**
 * The set of bins the pre-issue-58 sandbox exposed unconditionally. Used
 * as the "default policy" whenever an agent has neither `permissions[]`
 * nor `presetId` — i.e. legacy migration path. Keeps existing agents 100%
 * functional until the migration flips them over.
 */
export const LEGACY_BASH_WHITELIST: ReadonlySet<string> = new Set([
  'bun',
  'bunx',
  'node',
  'npm',
  'pnpm',
  'git',
  'go',
  'uv',
  'pytest',
  'ruff',
  'rg',
  'cat',
  'ls',
  'head',
  'tail',
  'find',
  'make',
])

/**
 * Legacy default policy: mirrors the historical `COMMAND_WHITELIST` +
 * `assertGitSafe` behavior (push to task branches allowed, `main` blocked,
 * branch ops + reset --hard + worktree remove blocked). No `gh` — the
 * legacy sandbox never had it.
 */
export const LEGACY_DEFAULT_POLICY: CompiledPolicy = {
  toolNames: new Set(), // Empty ⇒ resolveTools falls back to the agent's tools[] filter.
  bash: {
    bins: new Set(LEGACY_BASH_WHITELIST),
    git: {
      allowReadonly: true,
      allowPushTask: true,
      allowPushMain: false,
      allowBranchOps: false,
      allowResetHard: false,
      allowWorktreeRemove: false,
    },
  },
}

// ─── Expansion helpers ────────────────────────────────────────────────────

function expandBashScope(
  scope: string,
  bins: Set<string>,
  git: CompiledPolicy['bash']['git'],
): void {
  const scopedBins = BASH_SCOPE_BINS[scope]
  if (scopedBins) for (const b of scopedBins) bins.add(b)
  if (scope === 'git.readonly') git.allowReadonly = true
  if (scope === 'git.write.task') {
    git.allowReadonly = true
    git.allowPushTask = true
  }
  if (scope === 'git.write.main') {
    git.allowReadonly = true
    git.allowPushTask = true
    git.allowPushMain = true
  }
  if (scope === 'git.destructive') {
    git.allowBranchOps = true
    git.allowResetHard = true
    git.allowWorktreeRemove = true
  }
}

function expandCategory(cat: ToolCategory, out: Set<string>): void {
  for (const t of getToolsByCategory(cat)) out.add(t.name)
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface CompilePolicyInput {
  presetId?: PermissionPresetId
  permissions?: readonly Permission[]
}

/**
 * Compile a permission set (preset + overrides) into a runtime policy.
 *
 *   - `presetId` expands to that preset's permissions[] first.
 *   - `permissions[]` is merged on top (union — overrides only ADD).
 *   - Categories expand to every tool tagged with that category (see
 *     `getToolsByCategory`).
 *   - `bash:<scope>` opts into that sub-scope's bins + git flags.
 *   - `bash` (no sub-scope) is treated as `bash:shell.generic + bash:bun +
 *     bash:git.readonly + bash:git.write.task` — the historical default.
 *   - `tool:<name>` allow-lists a single tool by canonical id (aliases
 *     resolved).
 *
 * Duplicates are idempotent. Unknown categories / scopes / tools are
 * silently ignored — the schema validates them at the boundary; here we
 * stay lenient so a stale preset name never crashes an in-flight dispatch.
 */
export function compilePolicy(input: CompilePolicyInput): CompiledPolicy {
  const toolNames = new Set<string>()
  const bins = new Set<string>()
  const git: CompiledPolicy['bash']['git'] = {
    allowReadonly: false,
    allowPushTask: false,
    allowPushMain: false,
    allowBranchOps: false,
    allowResetHard: false,
    allowWorktreeRemove: false,
  }

  const permissions: Permission[] = []
  if (input.presetId) {
    const preset = PRESET_BY_ID[input.presetId]
    if (preset) permissions.push(...preset.permissions)
  }
  if (input.permissions) permissions.push(...input.permissions)

  for (const perm of permissions) {
    if (perm === 'bash') {
      // Bare `bash` — legacy-equivalent default sub-scopes.
      expandBashScope('shell.generic', bins, git)
      expandBashScope('bun', bins, git)
      expandBashScope('git.readonly', bins, git)
      expandBashScope('git.write.task', bins, git)
      // `bash_run` itself must be in the tool list for the agent to invoke it.
      for (const t of getToolsByCategory('bash')) toolNames.add(t.name)
      continue
    }
    if (perm.startsWith('bash:')) {
      const scope = perm.slice('bash:'.length)
      expandBashScope(scope, bins, git)
      for (const t of getToolsByCategory('bash')) toolNames.add(t.name)
      continue
    }
    if (perm.startsWith('tool:')) {
      const [canonical] = resolveAliases([perm.slice('tool:'.length)])
      if (canonical) toolNames.add(canonical)
      continue
    }
    // Bare category name (fs.read, fs.write, task.write, task.transition,
    // workspace).
    expandCategory(perm as ToolCategory, toolNames)
  }

  return { toolNames, bash: { bins, git } }
}

/** Convenience: expose the preset table so `/api/permission-presets` can
 *  return them without importing the composition layer directly from a
 *  route file. */
export function listPresets(): PermissionPresetDef[] {
  return ALL_PRESETS
}
