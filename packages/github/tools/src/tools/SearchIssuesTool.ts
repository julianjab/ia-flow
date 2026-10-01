import { z } from 'zod'
import { GithubTool } from '../GithubTool.js'
import type { GithubIssueApiShape } from '../shared.js'

export const SearchIssuesInput = z.strictObject({
  query: z
    .string()
    .min(1)
    .describe('Query de la GitHub Search API tal cual — ej. "repo:o/r is:issue is:open label:bug"'),
})
export type SearchIssuesInput = z.infer<typeof SearchIssuesInput>

export class SearchIssuesTool extends GithubTool<typeof SearchIssuesInput> {
  readonly name = 'github_search_issues'
  readonly description =
    'Busca issues/PRs con la sintaxis de búsqueda de GitHub (ej. "repo:o/r is:issue is:open label:bug").'
  readonly input = SearchIssuesInput

  protected async execute(input: SearchIssuesInput): Promise<string> {
    const result = await this.client.requestJson<{ items: GithubIssueApiShape[] }>(
      `/search/issues?q=${encodeURIComponent(input.query)}`,
    )
    return JSON.stringify(result.items.map((issue) => this.summarizeIssue(issue)))
  }
}
