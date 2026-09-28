import {
  parseGithubPullRequestPayload,
  parseGithubPullRequestReviewPayload,
} from '@ia-tools/github-webhook'
import { linkedIssue, type Resolution, ResolveAction, taskArgs } from './resolve.js'

/**
 * `github.pull_request` / `github.pull_request_review` → la task que el PR implementa (rama
 * `ia-flow/<n>` o `Closes #n`; sin ninguna, el PR mismo), con el PR aplanado en `pr.*` y, para
 * una review, `state`/`reviewer`/`body` en la raíz — lo que filtra `pr-changes-requested`.
 */
export class ResolvePullRequestAction extends ResolveAction {
  readonly description = 'Resuelve la task de un webhook pull_request o pull_request_review'

  constructor(
    intake: ConstructorParameters<typeof ResolveAction>[0],
    private readonly event: 'pull_request' | 'pull_request_review',
  ) {
    super(intake)
  }

  protected async resolve(raw: Record<string, unknown>): Promise<Resolution> {
    const review =
      this.event === 'pull_request_review' ? parseGithubPullRequestReviewPayload(raw) : undefined
    const pr = review ?? parseGithubPullRequestPayload(raw)
    const project = this.intake.projectForRepo(pr.owner, pr.repo)
    if (!project) return this.skip(`${pr.owner}/${pr.repo} no pertenece a ningún proyecto`)

    const number = linkedIssue(pr.headRef, pr.body, project.branchPrefix) ?? pr.number
    const item = await this.boardItem(project, pr.owner, pr.repo, number)
    if (!item) return this.notOnBoard(project, pr.owner, pr.repo, number)

    const args = taskArgs(this.event, { owner: pr.owner, repo: pr.repo, number }, item)
    args.pr = pr.number
    args.extra = {
      action: raw.action,
      pr: {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        isDraft: pr.isDraft,
        merged: pr.merged,
        author: pr.author,
        head: { ref: pr.headRef, sha: pr.headSha },
        base: { ref: pr.baseRef },
        url: pr.url,
      },
      ...(review
        ? { state: review.reviewState, reviewer: review.reviewer, body: review.reviewBody }
        : {}),
    }
    return this.emit(project, args)
  }
}
