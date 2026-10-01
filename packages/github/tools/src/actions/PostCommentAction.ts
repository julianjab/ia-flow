import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { issuePath } from '../shared.js'
import {
  type IssueRefResolver,
  issueFromPayload,
  type PrNumberResolver,
  prFromPayload,
} from './issueRef.js'

export const CommentTarget = z.enum(['issue', 'pr', 'pr-else-issue'])
export type CommentTarget = z.infer<typeof CommentTarget>

export const PostCommentInput = z.strictObject({
  summary: z.string().min(1).describe('Qué hiciste en este turno, en markdown'),
  validations: z
    .array(z.string().min(1))
    .describe('Qué verificaste (tests, lint, comportamiento) — una entrada por validación'),
  target: CommentTarget.optional().describe(
    'Dónde comentar — default: el PR si hay, si no el issue',
  ),
})
export type PostCommentInput = z.infer<typeof PostCommentInput>

/** Marca que las reglas de claw-agents usan para ignorar comentarios del propio pipeline
 *  (`body $matches ^(?![\s\S]*<!-- ia-flow:)`): sin ella, un reporte dispararía `comment-triage`. */
export const REPORT_MARKER = '<!-- ia-flow:report -->'

export interface PostCommentActionOptions {
  client: GithubClient
  /** Encabezado del comentario — típicamente el nombre del agente. */
  heading?: string
  issue?: IssueRefResolver
  pr?: PrNumberResolver
  id?: string
}

function render(heading: string | undefined, input: PostCommentInput): string {
  const validations =
    input.validations.length > 0
      ? input.validations.map((validation) => `- ${validation}`).join('\n')
      : '- (ninguna)'
  return [
    heading ? `### ${heading}` : undefined,
    '**Qué hice**',
    input.summary,
    '**Validaciones**',
    validations,
    REPORT_MARKER,
  ]
    .filter((line) => line !== undefined)
    .join('\n\n')
}

/**
 * El cierre de un turno (`report`) como comentario en GitHub — reemplaza el auto-comment de
 * `close_task` y el `comment` de los `exits` de ia-flow. El formato ("Qué hice" + "Validaciones")
 * deja de ser una convención del prompt y pasa a ser un schema: un agente que cierra sin
 * validaciones recibe el error y lo corrige.
 *
 * `target` lo fija el operador en cada nivel de la cascada: `postComment.bind({ target: 'issue' })`
 * para los refiners, `'pr-else-issue'` como default del proyecto. Un PR y un issue comparten el
 * endpoint de comentarios de la REST API.
 */
export class PostCommentAction extends Action<typeof PostCommentInput> {
  readonly description = 'Publica el reporte de cierre del turno en el issue o en su PR.'
  readonly input = PostCommentInput
  private readonly client: GithubClient
  private readonly heading?: string
  private readonly resolveIssue: IssueRefResolver
  private readonly resolvePr: PrNumberResolver

  constructor(options: PostCommentActionOptions) {
    super({ id: options.id ?? 'post_comment' })
    this.client = options.client
    this.heading = options.heading
    this.resolveIssue = options.issue ?? issueFromPayload
    this.resolvePr = options.pr ?? prFromPayload
  }

  async execute(input: PostCommentInput, ctx: PipelineExecutionContext): Promise<string> {
    const issue = this.resolveIssue(ctx)
    const target = input.target ?? 'pr-else-issue'
    const pr = target === 'issue' ? undefined : this.resolvePr(ctx)
    if (target === 'pr' && pr === undefined) {
      throw new Error('post_comment: target "pr" pero la corrida no tiene un PR')
    }
    const number = pr ?? issue.number

    const comment = await this.client.requestJson<{ html_url: string }>(
      issuePath(issue.owner, issue.repo, number, '/comments'),
      { method: 'POST', body: JSON.stringify({ body: render(this.heading, input) }) },
    )
    return `Comentario publicado: ${comment.html_url}`
  }
}
