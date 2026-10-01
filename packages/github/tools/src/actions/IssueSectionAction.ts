import { Action, type PipelineExecutionContext, type ToolInputSchema } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import type { z } from 'zod'
import { issuePath } from '../shared.js'
import { type IssueRefResolver, issueFromPayload } from './issueRef.js'
import { carryChecks, readSection, writeSection } from './issueSection.js'

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

  constructor(options: IssueSectionActionOptions<S>) {
    super({ id: options.id ?? `update_${options.section.id.replace(/[.-]/g, '_')}` })
    this.client = options.client
    this.section = options.section
    this.input = options.section.schema
    this.resolveIssue = options.issue ?? issueFromPayload
    this.description =
      options.description ??
      `Escribe el ${options.section.title} del issue de la corrida. Reemplaza SÓLO ese bloque del body — el resto queda intacto — así que mandá el ${options.section.title} completo, no un parche.`
  }

  async execute(input: z.infer<S>, ctx: PipelineExecutionContext): Promise<string> {
    const issue = this.resolveIssue(ctx)
    const path = issuePath(issue.owner, issue.repo, issue.number)
    const current = await readBody(this.client, path)
    const previous = readSection(current, this.section.id)
    const rendered = this.section.render(input)
    const markdown = previous ? carryChecks(previous, rendered) : rendered
    const body = writeSection(current, this.section.id, markdown)
    await this.client.requestJson(path, { method: 'PATCH', body: JSON.stringify({ body }) })
    return `${this.section.title} actualizado en ${issue.owner}/${issue.repo}#${issue.number} (${markdown.length} caracteres)`
  }
}

export { readBody as readIssueBody }
