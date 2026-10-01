import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { issuePath } from '../shared.js'
import { readIssueBody } from './IssueSectionAction.js'
import { type IssueRefResolver, issueFromPayload } from './issueRef.js'
import { setChecked } from './issueSection.js'

export const CheckSectionItemsInput = z.strictObject({
  items: z
    .array(z.number().int().positive())
    .min(1)
    .describe('Números de ítem a tildar, contando desde 1 en el orden de la lista'),
  uncheck: z
    .boolean()
    .optional()
    .describe('true para destildar (un ítem que tildaste y resultó no estar hecho)'),
})
export type CheckSectionItemsInput = z.infer<typeof CheckSectionItemsInput>

export interface CheckSectionItemsActionOptions {
  client: GithubClient
  /** Id del bloque que contiene el checklist — ej. `prd.zona_de_impacto`. */
  section: string
  /** Para la descripción de la tool: "Tilda ítems de <title>". */
  title: string
  issue?: IssueRefResolver
  /** Default: `check_<section>` con `-`/`.` como `_`. */
  id?: string
}

/**
 * Tilda ítems de UN checklist del body — ej. el implementer marcando la "Zona de impacto" del
 * PRD a medida que avanza. Es todo lo que puede hacer sobre ese bloque: no reescribe texto, no
 * agrega ni borra ítems. Así un agente que sólo reporta progreso no puede, por error, reescribir
 * el PRD que otro escribió.
 */
export class CheckSectionItemsAction extends Action<typeof CheckSectionItemsInput, string> {
  readonly description: string
  readonly input = CheckSectionItemsInput
  private readonly client: GithubClient
  private readonly section: string
  private readonly resolveIssue: IssueRefResolver

  constructor(options: CheckSectionItemsActionOptions) {
    super({ id: options.id ?? `check_${options.section.replace(/[.-]/g, '_')}` })
    this.client = options.client
    this.section = options.section
    this.resolveIssue = options.issue ?? issueFromPayload
    this.description = `Tilda ítems de ${options.title} en el body del issue (- [ ] → - [x]). Sólo cambia las casillas: el texto de cada ítem queda igual.`
  }

  async execute(input: CheckSectionItemsInput, ctx: PipelineExecutionContext): Promise<string> {
    const issue = this.resolveIssue(ctx)
    const path = issuePath(issue.owner, issue.repo, issue.number)
    const checked = !input.uncheck
    const { body, items } = setChecked(
      await readIssueBody(this.client, path),
      this.section,
      input.items,
      checked,
    )
    await this.client.requestJson(path, { method: 'PATCH', body: JSON.stringify({ body }) })
    const done = items.filter((item) => item.checked).length
    return `${checked ? 'Tildados' : 'Destildados'}: ${input.items.join(', ')} — ${done}/${items.length} hechos\n${items
      .map((item) => `${item.index}. [${item.checked ? 'x' : ' '}] ${item.text}`)
      .join('\n')}`
  }
}
