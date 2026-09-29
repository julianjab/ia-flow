import { Action } from '@ia-tools/agent-engine'
import { z } from 'zod'
import { type GithubProjectContext, resolveRepo } from './project.js'

const Input = z.strictObject({
  repo: z
    .string()
    .min(1)
    .describe('Repo del catálogo del proyecto (ej. "subscriptions"). El owner sale del proyecto.'),
  title: z.string().min(1).describe('Título del issue'),
  body: z.string().describe('Body en markdown'),
  labels: z.array(z.string().min(1)).optional().describe('Labels a aplicar al crearlo'),
})

/**
 * `create_github_issue` de ia-flow, mismo contrato: crea el issue y devuelve lo que las demás
 * tools necesitan para enlazarlo — `issueId` (node id, para `add_to_project` y
 * `mark_blocked_by`) y `numericId` (para `add_sub_issue`).
 */
export class CreateGithubIssueAction extends Action<typeof Input> {
  readonly description =
    'Crea un issue en un repo del proyecto. Para verlo en el board, seguí con add_to_project. Devuelve issueId (node id), issueNumber y numericId.'
  readonly input = Input

  constructor(private readonly project: GithubProjectContext) {
    super({ id: 'create_github_issue' })
  }

  async execute(input: z.infer<typeof Input>) {
    const { owner, repo } = resolveRepo(this.project, input.repo)
    const issue = await this.project.client.requestJson<{
      node_id: string
      number: number
      id: number
    }>(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels }),
    })
    return JSON.stringify({
      issueId: issue.node_id,
      issueNumber: issue.number,
      numericId: issue.id,
      owner,
      repo,
    })
  }
}
