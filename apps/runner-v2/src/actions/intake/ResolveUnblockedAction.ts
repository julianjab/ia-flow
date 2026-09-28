import { parseGithubPullRequestPayload } from '@ia-tools/github-webhook'
import {
  type IssueRef,
  linkedIssue,
  type Resolution,
  ResolveAction,
  type ResolvedTask,
  taskArgs,
} from './resolve.js'

/** El evento que recibe cada task que un prerrequisito cerrado destrabó. */
export const UNBLOCKED_EVENT = 'issue.unblocked'

/**
 * `github.pull_request` mergeado → las tasks que ESE issue bloqueaba (`mark_blocked_by`) y ya no
 * tienen ningún bloqueador abierto, cada una con su payload completo — el `unblock-dependents` de
 * ia-flow. Sin esto, cerrar el prerrequisito no destraba nada: el gate `item.blocked` sólo se
 * vuelve a mirar cuando llega un evento SOBRE la tarea bloqueada, y mergear su bloqueante no
 * genera ninguno.
 *
 * Se resuelve acá y no en una pipeline del proyecto porque el prerrequisito suele no ser una card
 * de este runner (el `when` del proyecto lo filtraría); las tasks que destraba, sí.
 */
export class ResolveUnblockedAction extends ResolveAction {
  readonly description = 'Resuelve las tasks que un PR mergeado destrabó'

  protected async resolve(raw: Record<string, unknown>): Promise<Resolution> {
    const pr = parseGithubPullRequestPayload(raw)
    if (!pr.merged) return this.skip(`PR #${pr.number} cerrado sin mergear`)
    const project = this.intake.projectForRepo(pr.owner, pr.repo)
    if (!project) return this.skip(`${pr.owner}/${pr.repo} no pertenece a ningún proyecto`)
    const blocker = linkedIssue(pr.headRef, pr.body, project.branchPrefix)
    if (blocker === undefined) return this.skip(`PR #${pr.number} no cierra ningún issue`)

    const closed = `https://github.com/${pr.owner}/${pr.repo}/issues/${blocker}`
    const dependents = await this.intake.dependents(pr.owner, pr.repo, blocker)
    const tasks: ResolvedTask[] = []
    for (const dependent of dependents.filter((issue) => issue.open)) {
      const task = await this.unblocked(dependent, closed)
      if (task) tasks.push(task)
    }
    if (tasks.length === 0) {
      return this.skip(
        `${pr.owner}/${pr.repo}#${blocker} no deja ninguna task de este runner sin bloqueadores`,
      )
    }
    return { emitEach: UNBLOCKED_EVENT, tasks }
  }

  /** La task de `issue`, si es de este runner y `closed` era su último bloqueador abierto. */
  private async unblocked(issue: IssueRef, closed: string): Promise<ResolvedTask | undefined> {
    const project = this.intake.projectForRepo(issue.owner, issue.repo)
    if (!project) return undefined
    const item = await this.boardItem(project, issue.owner, issue.repo, issue.number)
    if (!item) return undefined
    const { owner, repo, number } = issue
    const args = taskArgs(UNBLOCKED_EVENT, { owner, repo, number }, item)
    const { emit: _, ...task } = await this.emit(project, args, closed)
    const stillBlocked = (task.payload.item as { blocked?: boolean } | undefined)?.blocked
    if (stillBlocked) {
      this.intake.log(`· ${task.task} sigue bloqueada por otro prerrequisito`)
      return undefined
    }
    return task
  }
}
