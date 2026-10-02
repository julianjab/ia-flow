import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { ProjectsV2Fields } from '../board/ProjectsV2Fields.js'
import type { BoardWriter, ProjectRef } from '../board/types.js'
import { issuePath } from '../shared.js'
import { type IssueRef, type IssueRefResolver, issueFromPayload } from './issueRef.js'

export const UpdateIssueInput = z.strictObject({
  /** Atajo de `fields.Status`. */
  status: z.string().min(1).optional().describe('Columna del board (campo Status del proyecto)'),
  fields: z
    .record(z.string().min(1), z.string().min(1))
    .optional()
    .describe('Campos single-select del proyecto, por nombre: { "Task Type": "Technical" }'),
  clearFields: z
    .array(z.string().min(1))
    .optional()
    .describe('Campos del proyecto a vaciar, por nombre (ej. la marca "Working")'),
  addLabels: z.array(z.string().min(1)).optional().describe('Labels a agregar'),
  removeLabels: z.array(z.string().min(1)).optional().describe('Labels a sacar'),
  state: z.enum(['open', 'closed']).optional().describe('Abrir o cerrar el issue'),
})
export type UpdateIssueInput = z.infer<typeof UpdateIssueInput>

export type { ProjectRef }

export interface UpdateIssueActionOptions {
  client: GithubClient
  /** Dónde viven la columna y los campos de la card: un Project v2 (`project`) o cualquier board
   *  (`board`). Sin ninguno, la acción sólo maneja labels y estado; un `status`/`fields` tira. */
  project?: ProjectRef
  board?: BoardWriter
  issue?: IssueRefResolver
  id?: string
}

/**
 * Cambia el estado de un issue en el board — columna (`status`), otros campos single-select del
 * Project v2 (`fields`), labels y abierto/cerrado. Es el reemplazo del `$set:` de los `exits` de
 * ia-flow: una transición del board pasa a ser `updateIssue.bind({ status: 'Build' })` como
 * destino de una ruta, con el valor fijado por el operador y fuera del alcance del modelo.
 *
 * El issue sale del evento (`issue` resolver), nunca del input: el modelo no elige sobre qué
 * issue actúa. Los nombres de campos y opciones se comparan sin distinguir mayúsculas, igual que
 * el `$set:status=Build` de ia-flow.
 */
export class UpdateIssueAction extends Action<typeof UpdateIssueInput> {
  readonly description =
    'Actualiza el issue en el board: columna, campos del proyecto, labels y estado.'
  readonly input = UpdateIssueInput
  private readonly client: GithubClient
  private readonly board?: BoardWriter
  private readonly resolveIssue: IssueRefResolver

  constructor(options: UpdateIssueActionOptions) {
    super({ id: options.id ?? 'update_issue' })
    this.client = options.client
    this.board =
      options.board ??
      (options.project ? new ProjectsV2Fields(options.client, options.project) : undefined)
    this.resolveIssue = options.issue ?? issueFromPayload
  }

  async execute(input: UpdateIssueInput, ctx: PipelineExecutionContext): Promise<string> {
    const issue = this.resolveIssue(ctx)
    const changes: string[] = []
    const fields = { ...input.fields, ...(input.status ? { Status: input.status } : {}) }

    const clear = input.clearFields ?? []
    if (Object.keys(fields).length > 0 || clear.length > 0) {
      await this.setBoardFields(issue, fields, clear)
      changes.push(...Object.entries(fields).map(([name, value]) => `${name}=${value}`))
      changes.push(...clear.map((name) => `${name}=∅`))
    }
    if (input.addLabels?.length) {
      await this.client.requestJson(issuePath(issue.owner, issue.repo, issue.number, '/labels'), {
        method: 'POST',
        body: JSON.stringify({ labels: input.addLabels }),
      })
      changes.push(...input.addLabels.map((label) => `+${label}`))
    }
    for (const label of input.removeLabels ?? []) {
      const res = await this.client.request(
        issuePath(issue.owner, issue.repo, issue.number, `/labels/${encodeURIComponent(label)}`),
        { method: 'DELETE' },
      )
      // 404: el issue ya no tenía esa label — el estado final es el pedido, no es un error.
      if (!res.ok && res.status !== 404) {
        throw new Error(`update_issue: no se pudo sacar "${label}" → ${res.status}`)
      }
      changes.push(`-${label}`)
    }
    if (input.state) {
      await this.client.requestJson(issuePath(issue.owner, issue.repo, issue.number), {
        method: 'PATCH',
        body: JSON.stringify({ state: input.state }),
      })
      changes.push(`state=${input.state}`)
    }

    const target = `${issue.owner}/${issue.repo}#${issue.number}`
    return changes.length > 0 ? `${target}: ${changes.join(', ')}` : `${target}: sin cambios`
  }

  private async setBoardFields(
    issue: IssueRef,
    fields: Record<string, string>,
    clear: string[],
  ): Promise<void> {
    if (!this.board) {
      throw new Error(
        'update_issue: status/fields necesitan un Project v2 — pasá `project` al construir la acción',
      )
    }
    await this.board.setFields(issue, fields, clear)
  }
}
