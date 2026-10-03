import { Action, type PipelineExecutionContext, type ToolInputSchema } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import type { z } from 'zod'
import { issuePath } from '../shared.js'
import { type IssueRefResolver, issueFromPayload } from './issueRef.js'
import { carryChecks, readSection, splitManaged, writeSection } from './issueSection.js'

/** Un bloque del body con forma: qué datos lleva y cómo se ven en markdown. */
export interface IssueSectionDefinition<S extends ToolInputSchema = ToolInputSchema> {
  /** Id del bloque — el de los marcadores `<!-- ia-flow:<id> -->`. */
  id: string
  /** Para la descripción de la tool: "Escribe el <title> del issue". */
  title: string
  schema: S
  /** Los datos ya validados → el markdown del bloque. Los sub-bloques (ej. un checklist que
   *  otra acción tilda) los envuelve `render` con `wrapSection`. */
  render: (data: z.infer<S>) => string
}

export interface IssueSectionActionOptions<S extends ToolInputSchema> {
  client: GithubClient
  section: IssueSectionDefinition<S>
  issue?: IssueRefResolver
  /** Default: `update_<section.id>` con `-`/`.` como `_`. */
  id?: string
  description?: string
  /**
   * Qué pasa con lo que está FUERA de los bloques (la descripción que escribió una persona):
   * - `keep` (default): queda intacto, y el bloque se agrega debajo.
   * - `absorb`: se guarda como un comentario del issue y el body queda sólo con los bloques. El
   *   bloque pasa a ser LA descripción: sin dos documentos duplicados, y sin perder lo que escribió
   *   quien abrió el issue.
   */
  original?: 'keep' | 'absorb'
}

/** El marcador del comentario donde queda la descripción original: lleva el prefijo `ia-flow:`, así
 *  la regla de comentarios del engine no lo toma por un pedido humano. */
export const ORIGINAL_BODY_MARKER = '<!-- ia-flow:original-body -->'

function originalComment(original: string): string {
  return [
    ORIGINAL_BODY_MARKER,
    '### Descripción original',
    '',
    'El refiner la absorbió en el PRD del issue, que ahora es el body completo. Queda acá tal cual la escribió quien abrió el issue.',
    '',
    '<details>',
    '<summary>Ver la descripción original</summary>',
    '',
    original,
    '',
    '</details>',
  ].join('\n')
}

async function readBody(client: GithubClient, path: string): Promise<string> {
  const issue = await client.requestJson<{ body: string | null }>(path)
  return issue.body ?? ''
}

/**
 * Escribe UN bloque del body del issue a partir de datos validados por un schema — ej. el PRD del
 * refiner. A diferencia de `update_issue_body`, el modelo no manda markdown: manda los campos, y
 * lo que está fuera del bloque (la descripción del humano, el bloque de otro agente) sobrevive.
 * Reescribe el bloque completo en cada llamada, conservando las casillas ya tildadas de los ítems
 * que no cambiaron de texto (`carryChecks`).
 */
export class IssueSectionAction<S extends ToolInputSchema> extends Action<S, string> {
  readonly description: string
  readonly input: S
  private readonly client: GithubClient
  private readonly section: IssueSectionDefinition<S>
  private readonly resolveIssue: IssueRefResolver
  private readonly original: 'keep' | 'absorb'

  constructor(options: IssueSectionActionOptions<S>) {
    super({ id: options.id ?? `update_${options.section.id.replace(/[.-]/g, '_')}` })
    this.client = options.client
    this.section = options.section
    this.input = options.section.schema
    this.resolveIssue = options.issue ?? issueFromPayload
    this.original = options.original ?? 'keep'
    this.description =
      options.description ??
      (this.original === 'absorb'
        ? `Escribe el ${options.section.title} del issue de la corrida y lo deja como el body COMPLETO: la descripción original se guarda como un comentario, así que el ${options.section.title} tiene que cubrir todo lo que ella pedía. Mandalo completo, no un parche.`
        : `Escribe el ${options.section.title} del issue de la corrida. Reemplaza SÓLO ese bloque del body — el resto queda intacto — así que mandá el ${options.section.title} completo, no un parche.`)
  }

  async execute(input: z.infer<S>, ctx: PipelineExecutionContext): Promise<string> {
    const issue = this.resolveIssue(ctx)
    const path = issuePath(issue.owner, issue.repo, issue.number)
    let current = await readBody(this.client, path)
    if (this.original === 'absorb') current = await this.absorb(current, path)
    const previous = readSection(current, this.section.id)
    const rendered = this.section.render(input)
    const markdown = previous ? carryChecks(previous, rendered) : rendered
    const body = writeSection(current, this.section.id, markdown)
    await this.client.requestJson(path, { method: 'PATCH', body: JSON.stringify({ body }) })
    return `${this.section.title} actualizado en ${issue.owner}/${issue.repo}#${issue.number} (${markdown.length} caracteres)`
  }

  /**
   * Guarda lo que hay fuera de los bloques como un comentario y devuelve el body sólo con los
   * bloques. El comentario va PRIMERO: si falla, el body queda como estaba y no se pierde nada.
   */
  private async absorb(body: string, path: string): Promise<string> {
    const { blocks, outside } = splitManaged(body)
    if (!outside) return body
    await this.client.requestJson(`${path}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: originalComment(outside) }),
    })
    return blocks.join('\n\n')
  }
}

export { readBody as readIssueBody }
