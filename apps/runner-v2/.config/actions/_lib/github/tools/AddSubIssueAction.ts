import { Action } from '@ia-flow/agent-engine'
import { z } from 'zod'
import { type GithubProjectContext, resolveRepo } from './project.js'

const Input = z.strictObject({
  parent_repo: z.string().min(1).describe('Repo del catálogo donde vive el issue padre'),
  parent_issue_number: z.number().int().positive().describe('Número del issue padre'),
  child_numeric_id: z
    .number()
    .int()
    .positive()
    .describe('Id numérico (de base de datos) del hijo — el `numericId` de create_github_issue'),
})

/** `add_sub_issue` de ia-flow: enlaza un issue como sub-issue de otro. */
export class AddSubIssueAction extends Action<typeof Input> {
  readonly description = 'Enlaza un issue como sub-issue (hijo) de un issue padre.'
  readonly input = Input

  constructor(private readonly project: GithubProjectContext) {
    super({ id: 'add_sub_issue' })
  }

  async execute(input: z.infer<typeof Input>) {
    const { owner, repo } = resolveRepo(this.project, input.parent_repo)
    await this.project.client.requestJson(
      `/repos/${owner}/${repo}/issues/${input.parent_issue_number}/sub_issues`,
      {
        method: 'POST',
        body: JSON.stringify({ sub_issue_id: input.child_numeric_id }),
      },
    )
    return `Sub-issue enlazado: ${input.child_numeric_id} → padre ${owner}/${repo}#${input.parent_issue_number}`
  }
}
