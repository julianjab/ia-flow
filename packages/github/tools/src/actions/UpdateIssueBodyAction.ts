import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { issuePath } from '../shared.js'
import { type IssueRefResolver, issueFromPayload } from './issueRef.js'
import { readSection, writeSection } from './issueSection.js'

export const UpdateIssueBodyInput = z.strictObject({
  body: z
    .string()
    .min(1)
    .describe('Contenido completo en markdown. Reemplaza el body actual del issue.'),
  // Los prompts de ia-flow le piden al modelo pasarlo: se acepta para no forzar un reintento,
  // pero no se usa — el issue sale del evento, nunca del modelo.
  task_id: z.string().optional().describe('Opcional — se resuelve del contexto de la corrida.'),
})
export type UpdateIssueBodyInput = z.infer<typeof UpdateIssueBodyInput>

export interface UpdateIssueBodyActionOptions {
  client: GithubClient
  issue?: IssueRefResolver
  id?: string
  /** Bloques con dueño (`<!-- ia-flow:<id> -->`) que el body nuevo conserva del viejo si no los
   *  trae: los escribe otro (ej. `slack`, el link del hilo de review), y reescribir el PRD no los
   *  puede borrar. */
  keepSections?: string[]
}

/**
 * Reemplaza el body del issue — `update_issue_body` de ia-flow. Es donde el refiner deja el PRD
 * y el functional-refiner el PRD funcional: el entregable de esos agentes. Escribe, así que un
 * agente sólo la recibe como tool con `allowWrite()`.
 */
export class UpdateIssueBodyAction extends Action<typeof UpdateIssueBodyInput, string> {
  readonly description =
    'Reemplaza el body (descripción) del issue de la corrida con el markdown completo que pases — ej. el PRD.'
  readonly input = UpdateIssueBodyInput
  private readonly client: GithubClient
  private readonly resolveIssue: IssueRefResolver
  private readonly keepSections: string[]

  constructor(options: UpdateIssueBodyActionOptions) {
    super({ id: options.id ?? 'update_issue_body' })
    this.client = options.client
    this.resolveIssue = options.issue ?? issueFromPayload
    this.keepSections = options.keepSections ?? []
  }

  async execute(input: UpdateIssueBodyInput, ctx: PipelineExecutionContext): Promise<string> {
    const issue = this.resolveIssue(ctx)
    const path = issuePath(issue.owner, issue.repo, issue.number)
    const body = await this.withKeptSections(path, input.body)
    await this.client.requestJson(path, { method: 'PATCH', body: JSON.stringify({ body }) })
    return `Body actualizado: ${issue.owner}/${issue.repo}#${issue.number} (${input.body.length} caracteres)`
  }

  /** `next` con los bloques de `keepSections` del body actual que no trae. */
  private async withKeptSections(path: string, next: string): Promise<string> {
    if (this.keepSections.length === 0) return next
    const current = (await this.client.requestJson<{ body?: string | null }>(path)).body ?? ''
    let body = next
    for (const id of this.keepSections) {
      const kept = readSection(current, id)
      if (kept !== undefined && readSection(body, id) === undefined) {
        body = writeSection(body, id, kept)
      }
    }
    return body
  }
}
