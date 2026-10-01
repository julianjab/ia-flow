import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { issuePath } from '../shared.js'
import { type IssueRefResolver, issueFromPayload } from './issueRef.js'

export const ListSubIssuesBriefInput = z.strictObject({
  repo: z
    .string()
    .min(1)
    .describe(
      'Repo name (ej. "subscriptions") donde vive el issue padre. El owner sale del contexto.',
    ),
  parent_issue_number: z.number().int().positive().describe('Número del issue padre'),
})
export type ListSubIssuesBriefInput = z.infer<typeof ListSubIssuesBriefInput>

export interface SubIssueBrief {
  number: number
  title: string
  state: string
  url: string
}

export interface ListSubIssuesBriefActionOptions {
  client: GithubClient
  /** De dónde sale el owner — default: el del issue del evento. */
  issue?: IssueRefResolver
  id?: string
}

const PER_PAGE = 100

/**
 * `list_sub_issues_brief` de ia-flow: el índice de los sub-issues de un padre — número, título,
 * estado y url, SIN bodies. Es la forma barata de ver la jerarquía; el `list_sub_issues` del MCP
 * de GitHub trae los issues completos y en una épica grande agota el contexto.
 *
 * El owner sale del evento (no del modelo): el modelo elige el repo y el padre, dentro de la
 * organización de la corrida. Sólo lee.
 */
export class ListSubIssuesBriefAction extends Action<typeof ListSubIssuesBriefInput, string> {
  readonly description =
    'Índice compacto de los sub-issues de un issue padre: número, título, estado y url — SIN los bodies. Es la forma barata de ver qué hermanos existen y decidir a cuál vale la pena leerle el body después (eso se pide aparte). Preferila al list_sub_issues del MCP de GitHub, que devuelve los issues completos y en una épica grande agota el contexto.'
  readonly input = ListSubIssuesBriefInput
  override readonly sideEffects = 'none' as const
  private readonly client: GithubClient
  private readonly resolveIssue: IssueRefResolver

  constructor(options: ListSubIssuesBriefActionOptions) {
    super({ id: options.id ?? 'list_sub_issues_brief' })
    this.client = options.client
    this.resolveIssue = options.issue ?? issueFromPayload
  }

  async execute(input: ListSubIssuesBriefInput, ctx: PipelineExecutionContext): Promise<string> {
    const { owner } = this.resolveIssue(ctx)
    const parent = input.parent_issue_number
    const subIssues: SubIssueBrief[] = []
    for (let page = 1; ; page++) {
      const data = await this.client.requestJson<unknown>(
        `${issuePath(owner, input.repo, parent, '/sub_issues')}?per_page=${PER_PAGE}&page=${page}`,
      )
      // TIRA en vez de degradar a lista vacía: `[]` es indistinguible de "este padre no tiene
      // sub-issues", y con ese dato el functional-refiner decide entre reconciliar y CREAR — un
      // `[]` espurio sobre una épica ya desglosada le haría recrear todos los hijos.
      if (!Array.isArray(data)) {
        throw new Error(
          `list_sub_issues_brief: sub_issues de #${parent} (página ${page}) no devolvió una lista: ${JSON.stringify(data)?.slice(0, 200)}`,
        )
      }
      for (const item of data as Array<Record<string, unknown>>) {
        subIssues.push({
          number: item.number as number,
          title: item.title as string,
          state: item.state as string,
          url: item.html_url as string,
        })
      }
      if (data.length < PER_PAGE) break
    }
    return JSON.stringify({ count: subIssues.length, subIssues })
  }
}
