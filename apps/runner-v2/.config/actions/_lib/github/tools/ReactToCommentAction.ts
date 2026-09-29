import { Action, type PipelineExecutionContext } from '@ia-tools/agent-engine'
import type { GithubClient } from '@ia-tools/github-api'
import { issueFromPayload } from '@ia-tools/github-tools'
import { z } from 'zod'

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

const ReactInput = z.strictObject({
  comment_id: z.number().int().positive().describe('El `comment id` que te dio el brief'),
  reaction: z.enum(['+1', '-1']).describe('+1 si el comentario es accionable, -1 si no'),
})

/** `react_to_comment` de ia-flow: el acuse de recibo visible para quien comentó. */
export class ReactToCommentAction extends Action<typeof ReactInput> {
  readonly description =
    'Reacciona a un comentario del issue/PR (+1 accionable, -1 no accionable) — tu acuse de recibo visible.'
  readonly input = ReactInput

  constructor(private readonly client: GithubClient) {
    super({ id: 'react_to_comment' })
  }

  async execute(input: z.infer<typeof ReactInput>, ctx: PipelineExecutionContext) {
    const { owner, repo } = issueFromPayload(ctx)
    if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(repo)) {
      throw new Error(`react_to_comment: owner/repo inválidos: ${owner}/${repo}`)
    }
    await this.client.requestJson(
      `/repos/${owner}/${repo}/issues/comments/${input.comment_id}/reactions`,
      { method: 'POST', body: JSON.stringify({ content: input.reaction }) },
    )
    return `Reacción ${input.reaction} agregada al comentario ${input.comment_id}`
  }
}
