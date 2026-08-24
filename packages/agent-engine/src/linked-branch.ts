// Auto-link branch: applies to ANY provider (anthropic-api or terminal).
// Gate:
//   - explicit: agentDef.requiresBranch (toggle in the UI).
//   - default: derived from hasWriteTools (agents with
//     fs_write/fs_edit/bash_run). Covers the common case without forcing
//     the toggle on every builder agent.
// Only fires when the source exposes getLinkedBranchRef (GitHub adapter)
// and there's no task.branch yet. Terminal providers receive the resolved
// branch via ProviderInput.branch and terminal-base uses it in
// `claude --worktree <branch>` / `git checkout -b <branch>`.
import type { ITaskSource } from '@ia-flow/issue-sources'
import { createLinkedBranch } from '@ia-flow/issue-sources'
import type { AgentToolEntry, Task } from '@ia-flow/shared'
import { createLogger } from './logger.js'
import { hasWriteTools } from './write-access.js'

const log = createLogger('linked-branch')

export interface BranchNamerTaskLike {
  id: string
  title: string
  description?: string
  type?: string
}

/** Host-owned linked-branch namer (apps/server's application/branch-namer.ts
 *  — calls the Anthropic API directly and reads a system prompt from the DB).
 *  Injected so this package never imports apps/server directly. Defaults to
 *  the deterministic `task/<id>` fallback branch-namer.ts itself falls back
 *  to, so omitting the port doesn't change behaviour when nothing needs it. */
export type LinkedBranchNamer = (task: BranchNamerTaskLike) => Promise<string>

export const defaultLinkedBranchNamer: LinkedBranchNamer = async (task) => `task/${task.id}`

export interface ResolveLinkedBranchInput {
  task: Task
  agentDef: { requiresBranch?: boolean; tools?: AgentToolEntry[] }
  /** Solo para el log. No se lee `agentDef.provider` directo porque puede ser
   *  un array de candidatos: el id ya resuelto lo da `resolveProvider`. */
  resolvedProviderId: string
  manager: ITaskSource
  linkedBranchNamer: LinkedBranchNamer
}

export async function resolveLinkedBranch({
  task,
  agentDef,
  resolvedProviderId,
  manager,
  linkedBranchNamer,
}: ResolveLinkedBranchInput): Promise<Task> {
  const agentNeedsBranch = agentDef.requiresBranch ?? hasWriteTools({ tools: agentDef.tools })
  if (!agentNeedsBranch || task.branch) return task

  const ref = manager.getLinkedBranchRef?.(task)
  if (!ref) return task

  const proposed = await linkedBranchNamer({
    id: task.id,
    title: task.title,
    description: task.description,
    type: task.type,
  })
  try {
    const result = await createLinkedBranch(ref.issueNodeId, proposed, ref.owner, ref.repoName)
    const next = { ...task, branch: result.name }
    log.info(
      {
        taskId: task.id,
        branch: result.name,
        created: result.created,
        provider: resolvedProviderId,
      },
      'Linked branch resolved for agent',
    )
    return next
  } catch (err) {
    log.warn(
      { err, taskId: task.id, proposed },
      'createLinkedBranch failed — falling back to task/<id> for this run',
    )
    return task
  }
}
