import { z } from 'zod'
import { GithubTool } from '../GithubTool.js'
import type { GithubIssueApiShape } from '../shared.js'

export const GetIssueInput = z.strictObject({
  owner: z.string().describe('Dueño del repo, ej. "julianjab"'),
  repo: z.string().describe('Nombre del repo'),
  number: z.number().int().positive().describe('Número del issue'),
})
export type GetIssueInput = z.infer<typeof GetIssueInput>

export class GetIssueTool extends GithubTool<typeof GetIssueInput> {
  readonly name = 'github_get_issue'
  readonly description = 'Lee un issue de GitHub: título, cuerpo, estado y labels.'
  readonly input = GetIssueInput

  protected async execute(input: GetIssueInput): Promise<string> {
    const issue = await this.client.requestJson<GithubIssueApiShape>(
      this.issuePath(input.owner, input.repo, input.number),
    )
    return this.summarizeIssue(issue)
  }
}
