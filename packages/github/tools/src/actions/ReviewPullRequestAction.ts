/**
 * El review del reviewer sobre el PR: reemplaza al MCP de GitHub para ese rol, que además trae
 * `push_files`, `create_or_update_file`, `merge_pull_request`… con el token de la App.
 */
import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { prFrom } from './pr-ref.js'

/** El encabezado que distingue un hallazgo del reviewer del pedido de un humano. */
const HEADER = '# reviewer'

/** El cuerpo del review es para lo transversal, no para el resumen: el veredicto lo publica el
 *  engine con el `report` de la salida. Un body largo es casi siempre ese resumen repetido. */
const MAX_BODY = 1_500

const ReviewInput = z.strictObject({
  body: z
    .string()
    .max(
      MAX_BODY,
      `El body del review es sólo para hallazgos transversales cortos (máx. ${MAX_BODY} caracteres). El resumen y el veredicto NO van acá: van en el \`report\` de tu submit_* — si los repetís en el review, salen duplicados.`,
    )
    .optional()
    .describe(
      'Sólo hallazgos transversales, sin una línea a la cual colgarse, en pocas líneas. Vacío si todo va inline. NO el resumen ni el veredicto: eso va en el `report` de tu submit_*.',
    ),
  comments: z
    .array(
      z.strictObject({
        path: z.string().min(1).describe('Archivo, relativo a la raíz del repo'),
        line: z
          .number()
          .int()
          .positive()
          .describe('Línea del archivo en la versión del PR (lado derecho del diff)'),
        body: z
          .string()
          .min(1)
          .describe('Qué está mal, qué exige el PRD o la regla del repo, y la corrección concreta'),
      }),
    )
    .describe('Un comentario por hallazgo que vive en una línea concreta'),
})

/** Publica UN review `COMMENT` con todos los hallazgos inline — una sola notificación para el
 *  autor, ordenada por archivo. Nunca aprueba ni pide cambios: el veredicto formal es humano. */
export class ReviewPullRequestAction extends Action<typeof ReviewInput> {
  readonly description =
    'Publica tu review sobre el PR del encabezado: un COMMENT con un comentario inline por hallazgo (path + línea del lado nuevo) y, opcional, un body con lo transversal.'
  readonly input = ReviewInput

  constructor(private readonly client: GithubClient) {
    super({ id: 'review_pull_request' })
  }

  async execute(input: z.infer<typeof ReviewInput>, ctx: PipelineExecutionContext) {
    const pr = prFrom(ctx)
    if (input.comments.length === 0 && !input.body?.trim()) {
      return 'Nada que publicar: sin comentarios ni body.'
    }
    const tag = (body: string) =>
      body.trimStart().startsWith(HEADER) ? body : `${HEADER}\n${body}`
    const review = await this.client.requestJson<{ html_url?: string }>(
      `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
      {
        method: 'POST',
        body: JSON.stringify({
          commit_id: pr.sha,
          event: 'COMMENT',
          body: input.body?.trim() ? tag(input.body) : undefined,
          comments: input.comments.map((c) => ({
            path: c.path,
            line: c.line,
            side: 'RIGHT',
            body: tag(c.body),
          })),
        }),
      },
    )
    return `Review publicado en el PR #${pr.number} con ${input.comments.length} comentario(s) inline${
      review.html_url ? `: ${review.html_url}` : ''
    }`
  }
}
