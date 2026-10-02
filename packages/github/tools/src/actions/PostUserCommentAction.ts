import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { issuePath } from '../shared.js'
import { type IssueRefResolver, issueFromPayload } from './issueRef.js'

export const PostUserCommentInput = z.strictObject({
  body: z.string().trim().min(1).describe('El comentario, tal cual lo escribió la persona'),
})
export type PostUserCommentInput = z.infer<typeof PostUserCommentInput>

export interface PostUserCommentActionOptions {
  /** El cliente de quien comenta: el comentario queda a su nombre. */
  client: GithubClient
  issue?: IssueRefResolver
  id?: string
}

/**
 * Publica en el issue lo que escribió una persona, sin firma de agente ni la marca `<!-- ia-flow:`.
 * Sin la marca el comentario cuenta como humano: lo lee `task.comments` y, si el issue vuelve a
 * una etapa con agente, el pipeline de esa etapa lo ve. Para lo que dice el runner —un reporte, un
 * aviso— están `post_comment` y `post_notice`, que sí la llevan.
 */
export class PostUserCommentAction extends Action<typeof PostUserCommentInput> {
  readonly description = 'Publica en el issue el comentario de una persona, a su nombre.'
  readonly input = PostUserCommentInput
  private readonly client: GithubClient
  private readonly resolveIssue: IssueRefResolver

  constructor(options: PostUserCommentActionOptions) {
    super({ id: options.id ?? 'post_user_comment' })
    this.client = options.client
    this.resolveIssue = options.issue ?? issueFromPayload
  }

  async execute(input: PostUserCommentInput, ctx: PipelineExecutionContext): Promise<string> {
    const issue = this.resolveIssue(ctx)
    const comment = await this.client.requestJson<{ html_url: string }>(
      issuePath(issue.owner, issue.repo, issue.number, '/comments'),
      { method: 'POST', body: JSON.stringify({ body: input.body }) },
    )
    return `Comentario publicado: ${comment.html_url}`
  }
}
