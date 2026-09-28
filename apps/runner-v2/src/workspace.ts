/**
 * Qué checkout necesita una corrida de ESTE runner — la única pieza del workspace que es de la
 * app: cómo su evento se traduce a un `WorkspaceTarget`. El ciclo de vida (clone, worktree,
 * locks, limpieza) es `@ia-tools/workspace`.
 */
import type { PipelineExecutionContext } from '@ia-tools/agent-pipeline'
import type { WorkspaceTarget } from '@ia-tools/workspace'

/**
 * La task del payload (`task.id`, número, título → worktree `task-<n>`), su repo, y la branch:
 * la del PR si el evento es de un PR (así un PR abierto a mano, con otra branch, también se
 * revisa), si no la de la task (`task.branch`).
 */
export function workspaceTargetFor(ctx: PipelineExecutionContext): WorkspaceTarget {
  const payload = ctx.event.payload as {
    owner?: string
    repo?: string
    number?: number
    pr?: { head?: { ref?: string } }
    task?: { id?: string; title?: string; branch?: string }
  }
  const { owner, repo, number, pr, task } = payload
  const branch = pr?.head?.ref || task?.branch
  if (!owner || !repo || !task?.id || !branch) {
    throw new Error('workspace: el evento no dice qué task, repo y branch checkoutear')
  }
  return {
    task: { id: task.id, issueNumber: number, title: task.title },
    repo: { name: repo, githubOwner: owner, githubRepo: repo },
    branch,
  }
}
