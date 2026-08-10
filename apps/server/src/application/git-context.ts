// Engine-provided git context prepended to every agent prompt.
//
// The intent: agents should NOT decide branching strategy themselves. The
// engine (orchestrator + WorkspaceManager + terminal-base) already prepared
// the git environment before the agent runs. This module renders that
// environment as a short markdown block so the agent can act on it without
// running `git branch --show-current` or guessing branch names.
//
// Provider-specific:
//   • anthropic-api → runs inside a WorkspaceManager worktree (writer) or the
//     base repo (reader). Branch is always `task/<taskId>` when a worktree
//     exists.
//   • terminal (tmux/iterm) → obeys repo.workflow: main | branch | worktree.
//     The cmd built by terminal-base already applies the workflow to the
//     shell; this text just tells the agent what happened.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { branchNameFor } from './WorkspaceManager.js'

// Inlined (no dependemos de terminal-base para evitar ciclo:
// git-context ← AgentOrchestrator, y terminal-base → application/provider-config →
// composition/container → AgentOrchestrator).
const pexec = promisify(execFile)
async function resolveBaseBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 5_000,
    })
    const branch = stdout.trim()
    if (branch && branch !== 'HEAD') return branch
  } catch {
    /* fall through */
  }
  for (const candidate of ['main', 'master', 'develop']) {
    try {
      await pexec('git', ['-C', cwd, 'rev-parse', '--verify', candidate], { timeout: 3_000 })
      return candidate
    } catch {
      /* not found */
    }
  }
  return null
}

export type GitContextProvider = 'anthropic-api' | 'terminal'

export interface GitContextOptions {
  taskId: string
  provider: GitContextProvider
  cwd?: string
  /** Terminal only: 'main' | 'branch' | 'worktree'. Ignored for anthropic-api. */
  workflow?: 'main' | 'branch' | 'worktree'
  /** anthropic-api only: absolute worktree path if the agent has write access. */
  worktreePath?: string
  /** anthropic-api only: whether the agent can write. Read-only agents skip the "push/PR" line. */
  hasWriteAccess?: boolean
}

/**
 * Renders the git-context markdown block for a single agent run.
 *
 * Returns an empty string when there is nothing meaningful to say (no cwd,
 * or a step that shouldn't include git context). Callers prepend the
 * returned string to the agent's user prompt.
 */
export async function buildGitContext(opts: GitContextOptions): Promise<string> {
  const { taskId, provider, cwd, workflow, worktreePath, hasWriteAccess } = opts
  const branch = branchNameFor(taskId)

  if (provider === 'anthropic-api') {
    if (!cwd) return ''
    const baseBranch = (await resolveBaseBranch(cwd)) ?? 'main'
    if (worktreePath) {
      return [
        '## Git context',
        `- Provider: **anthropic-api** — worktree materializado por el engine (no crear branches manualmente).`,
        `- Branch: \`${branch}\` (based on \`${baseBranch}\`)`,
        `- Worktree path: \`${worktreePath}\``,
        `- When done: push \`${branch}\` y abrí PR contra \`${baseBranch}\` (usa el tool de GitHub MCP si está disponible).`,
      ].join('\n')
    }
    // Read-only agent (no writePaths) — read desde el base repo.
    return [
      '## Git context',
      `- Provider: **anthropic-api** (read-only).`,
      `- Read path: \`${cwd}\`.`,
      hasWriteAccess === false
        ? `- Sin write tools — no toques git. Si necesitás ver lo que un builder previo dejó, mirá commits en \`${branch}\`.`
        : `- Branch nominal: \`${branch}\`.`,
    ].join('\n')
  }

  // provider === 'terminal'
  if (!cwd) return ''
  if (workflow === 'main') {
    const baseBranch = (await resolveBaseBranch(cwd)) ?? 'main'
    return [
      '## Git context',
      `- Workflow: **main** — commit directly on \`${baseBranch}\`, no branch needed.`,
      `- Repo path: \`${cwd}\`.`,
    ].join('\n')
  }
  // Nunca dejamos el bloque vacío por un fallo transitorio de git; caemos a 'main'.
  const baseBranch = (await resolveBaseBranch(cwd)) ?? 'main'
  if (workflow === 'worktree') {
    return [
      '## Git context',
      `- Workflow: **worktree** — Claude created a git worktree for this session (flag \`--worktree ${branch}\`).`,
      `- Branch: \`${branch}\` (based on \`${baseBranch}\`).`,
      `- Main repo: \`${cwd}\`.`,
      `- When done: push \`${branch}\` and open a PR against \`${baseBranch}\`.`,
    ].join('\n')
  }
  // default: branch (in-place)
  return [
    '## Git context',
    `- Workflow: **branch** — a new branch has been checked out in-place.`,
    `- Branch: \`${branch}\` (based on \`${baseBranch}\`).`,
    `- Repo path: \`${cwd}\`.`,
    `- When done: push \`${branch}\` and open a PR against \`${baseBranch}\`.`,
  ].join('\n')
}
