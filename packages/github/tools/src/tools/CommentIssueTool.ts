import { z } from 'zod'
import { GithubTool } from '../GithubTool.js'

export const CommentIssueInput = z.strictObject({
  owner: z.string().describe('Dueño del repo, ej. "julianjab"'),
  repo: z.string().describe('Nombre del repo'),
  number: z.number().int().positive().describe('Número del issue'),
  body: z.string().min(1).describe('Texto del comentario, markdown permitido'),
})
export type CommentIssueInput = z.infer<typeof CommentIssueInput>

export class CommentIssueTool extends GithubTool<typeof CommentIssueInput> {
  readonly name = 'github_comment_issue'
  readonly description =
    'Publica un comentario en un issue (o PR — la API los trata igual) de GitHub.'
  readonly input = CommentIssueInput

  protected async execute(input: CommentIssueInput): Promise<string> {
    const comment = await this.client.requestJson<{ id: number; html_url: string }>(
      this.issuePath(input.owner, input.repo, input.number, '/comments'),
      { method: 'POST', body: JSON.stringify({ body: input.body }) },
    )
    return `Comentario publicado: ${comment.html_url}`
  }
}
