/**
 * La contracara escribible de las review threads que `{{task.comments}}` le muestra al agente
 * (`intake/timeline.ts`): cada hilo sin resolver trae su `thread <id>` en la
 * cabecera, y ese id viaja de vuelta acá. El modelo no busca nada — responde o resuelve el hilo
 * que leyó.
 */
import { Action } from '@ia-tools/agent-pipeline'
import type { GithubClient } from '@ia-tools/github-api'
import { z } from 'zod'

const THREAD_ID = /^PRRT_[A-Za-z0-9_-]+$/
const threadId = z.string().regex(THREAD_ID, 'un id de hilo de review (PRRT_…)')

const ReplyInput = z.strictObject({
  thread_id: threadId.describe(
    'Id del hilo, tal como aparece en la cabecera del comentario de review',
  ),
  body: z
    .string()
    .min(1)
    .describe(
      'Qué hiciste con el pedido, o por qué no aplica — concreto: se lee al lado del pedido',
    ),
})

const REPLY = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } }
}`

/** `reply_pr_review_thread` de ia-flow: responde DENTRO del hilo, no suelto en el PR. */
export class ReplyPrReviewThreadAction extends Action<typeof ReplyInput> {
  readonly description =
    'Responde dentro de un hilo de review del PR, al lado del pedido. Usá el thread id que viene en la cabecera del comentario de review.'
  readonly input = ReplyInput

  constructor(private readonly client: GithubClient) {
    super({ id: 'reply_pr_review_thread' })
  }

  async execute(input: z.infer<typeof ReplyInput>) {
    await this.client.graphql(REPLY, { threadId: input.thread_id, body: input.body })
    return `Respuesta publicada en el hilo ${input.thread_id}.`
  }
}

const ResolveInput = z.strictObject({ thread_id: threadId.describe('Id del hilo a resolver') })

const RESOLVE = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`

/** `resolve_pr_review_thread` de ia-flow. Un hilo resuelto deja de aparecer en
 *  `{{task.comments}}`: resolverlo de más es perder el pedido. */
export class ResolvePrReviewThreadAction extends Action<typeof ResolveInput> {
  readonly description =
    'Marca un hilo de review como resuelto. SÓLO cuando el pedido quedó atendido en el código pusheado — si dudás, respondé con reply_pr_review_thread y dejalo abierto.'
  readonly input = ResolveInput

  constructor(private readonly client: GithubClient) {
    super({ id: 'resolve_pr_review_thread' })
  }

  async execute(input: z.infer<typeof ResolveInput>) {
    await this.client.graphql(RESOLVE, { threadId: input.thread_id })
    return `Hilo ${input.thread_id} marcado como resuelto.`
  }
}
