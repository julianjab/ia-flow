import { parseGithubIssueCommentPayload } from '@ia-tools/github-webhook'
import { linkedIssue, type Resolution, ResolveAction, taskArgs } from './resolve.js'

/**
 * `github.issue_comment` → el comentario, sobre la task de la que habla y con su columna del
 * board. Un comentario hecho en un PR habla de la task que ese PR implementa, no del PR como
 * issue: se ubica por la rama `ia-flow/<n>` o el `Closes #n` del PR.
 */
export class ResolveIssueCommentAction extends ResolveAction {
  readonly description = 'Resuelve la task y el status del board de un webhook issue_comment'

  protected async resolve(raw: Record<string, unknown>): Promise<Resolution> {
    const comment = parseGithubIssueCommentPayload(raw)
    const project = this.intake.projectForRepo(comment.owner, comment.repo)
    if (!project)
      return this.skip(`${comment.owner}/${comment.repo} no pertenece a ningún proyecto`)

    let number = comment.number
    let pr: number | undefined
    if (comment.isPullRequest) {
      pr = comment.number
      const { headRef, body } = await this.intake.pullRequest(comment.owner, comment.repo, pr)
      number = linkedIssue(headRef, body, project.branchPrefix) ?? pr
    }
    const item = await this.boardItem(project, comment.owner, comment.repo, number)
    if (!item) return this.notOnBoard(project, comment.owner, comment.repo, number)

    const target = { owner: comment.owner, repo: comment.repo, number }
    const args = taskArgs(
      'issue_comment',
      target,
      item,
      comment.isPullRequest ? [] : comment.labels,
    )
    args.comment = comment.commentBody
    args.author = comment.sender
    args.commentId = comment.commentId
    args.pr = pr
    args.extra = { action: raw.action }
    return this.emit(project, args)
  }
}
