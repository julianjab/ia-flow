import { parseGithubCheckPayload } from '@ia-tools/github-webhook'
import { linkedIssue, type Resolution, ResolveAction, taskArgs } from './resolve.js'

/**
 * `github.check_suite` / `github.workflow_run` → la task de la corrida de CI: la de la rama
 * `ia-flow/<n>` o, si no, la del PR asociado. Una corrida sin ninguno de los dos (un push a main)
 * no es de ninguna task y se descarta.
 */
export class ResolveCiRunAction extends ResolveAction {
  readonly description = 'Resuelve la task de un webhook check_suite o workflow_run'

  constructor(
    intake: ConstructorParameters<typeof ResolveAction>[0],
    private readonly event: 'check_suite' | 'workflow_run',
  ) {
    super(intake)
  }

  protected async resolve(raw: Record<string, unknown>): Promise<Resolution> {
    const run = parseGithubCheckPayload(this.event, raw)
    const project = this.intake.projectForRepo(run.owner, run.repo)
    if (!project) return this.skip(`${run.owner}/${run.repo} no pertenece a ningún proyecto`)

    const prNumber = run.prNumbers[0]
    const number = linkedIssue(run.branch, '', project.branchPrefix) ?? prNumber
    if (number === undefined)
      return this.skip(`corrida sin PR ni rama ${project.branchPrefix}<n> (${run.branch})`)
    const item = await this.boardItem(project, run.owner, run.repo, number)
    if (!item) return this.notOnBoard(project, run.owner, run.repo, number)

    const args = taskArgs(this.event, { owner: run.owner, repo: run.repo, number }, item)
    args.pr = prNumber
    args.extra = {
      action: raw.action,
      conclusion: run.conclusion,
      status: run.status,
      name: run.name,
      branch: run.branch,
      sha: run.sha,
      url: run.url,
      prNumber,
      kind: this.event,
    }
    return this.emit(project, args)
  }
}
