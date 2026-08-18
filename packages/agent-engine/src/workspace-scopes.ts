// Per-agent workspace scope resolution. Only anthropic-api gets the
// WorkspaceManager sandbox: it's the sync provider that runs tools inside
// ToolContext and honours writePaths. Terminal providers keep the base repo
// path — they exec commands directly in cwd (they materialize their own
// worktree in terminal-base, using the same convention).
//
// Read-only agents (no write tools) still call resolveScopes so they *see*
// the worktree if a builder created one earlier in the chain (visibility
// invariant): the second agent inherits the worktree as read-only, no extra
// config. When no worktree exists yet, resolveScopes returns the base repo
// path — cheap fallback.
import type { Task } from '@ia-flow/shared'
import { type WorkspaceManager, hasWriteTools } from './WorkspaceManager.js'

export interface ResolveWorkspaceScopesInput {
  workspaceManager: WorkspaceManager | undefined
  agentDef: { provider: string; tools?: string[] }
  task: Task
  primaryPath: string | undefined
  primaryRepoName: string | undefined
  repoPaths: Record<string, string>
  runId: string
}

export interface ResolvedWorkspaceScopes {
  repoPaths: Record<string, string>
  writePaths: string[] | undefined
  /** Branch WorkspaceManager actually used, set only when it materialized (or
   *  reused) the worktree in this call. Callers that own the `Task` object
   *  (see `Agent.run`) should reflect it back onto `task.branch`. */
  branch: string | undefined
}

export async function resolveWorkspaceScopes({
  workspaceManager,
  agentDef,
  task,
  primaryPath,
  primaryRepoName,
  repoPaths,
  runId,
}: ResolveWorkspaceScopesInput): Promise<ResolvedWorkspaceScopes> {
  if (
    !(workspaceManager && agentDef.provider === 'anthropic-api' && primaryPath && primaryRepoName)
  ) {
    return { repoPaths, writePaths: undefined, branch: undefined }
  }

  const wsm = workspaceManager
  const agentToolNames = agentDef.tools
  // Materialize the worktree only when the agent has write tools — read-only
  // agents don't create it, they just inherit it if it exists. Recording the
  // runId here lets the next reuse tag its autosalvage commit with the
  // previous run's id.
  let worktreePath: string | undefined
  let branch: string | undefined
  if (hasWriteTools({ tools: agentToolNames })) {
    const created = await wsm.getOrCreateWorktree(task.id, primaryPath, { branch: task.branch })
    worktreePath = created.path
    branch = created.branch
    wsm.recordRunId(task.id, runId)
  }
  const worktreeExists = wsm.worktreeExistsOnDisk(task.id, primaryPath)
  const scopes = wsm.resolveScopes(
    { id: task.id, repos: task.repos },
    { tools: agentToolNames },
    { repoBasePath: primaryPath, worktreeExists, worktreePath },
  )
  return {
    repoPaths: { ...repoPaths, [primaryRepoName]: scopes.readPaths[0] },
    writePaths: scopes.writePaths,
    branch,
  }
}
