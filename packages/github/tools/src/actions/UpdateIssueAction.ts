import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { issuePath } from '../shared.js'
import { type IssueRef, type IssueRefResolver, issueFromPayload } from './issueRef.js'

export const UpdateIssueInput = z.strictObject({
  /** Atajo de `fields.Status`. */
  status: z.string().min(1).optional().describe('Columna del board (campo Status del proyecto)'),
  fields: z
    .record(z.string().min(1), z.string().min(1))
    .optional()
    .describe('Campos single-select del proyecto, por nombre: { "Task Type": "Technical" }'),
  addLabels: z.array(z.string().min(1)).optional().describe('Labels a agregar'),
  removeLabels: z.array(z.string().min(1)).optional().describe('Labels a sacar'),
  state: z.enum(['open', 'closed']).optional().describe('Abrir o cerrar el issue'),
})
export type UpdateIssueInput = z.infer<typeof UpdateIssueInput>

/** El Project v2 donde viven los campos (`Status`, `Task Type`, ...). */
export interface ProjectRef {
  /** Login de la organización o usuario dueño del proyecto. */
  owner: string
  number: number
}

export interface UpdateIssueActionOptions {
  client: GithubClient
  /** Sin esto, la acción sólo maneja labels y estado; un `status`/`fields` tira. */
  project?: ProjectRef
  issue?: IssueRefResolver
  id?: string
}

interface ProjectItemsData {
  repository: {
    issue: {
      projectItems: {
        nodes: Array<{
          id: string
          project: { id: string; number: number; owner: { login?: string } }
        }>
      }
    } | null
  } | null
}

interface ProjectFieldsData {
  node: {
    fields: {
      nodes: Array<{ id?: string; name?: string; options?: Array<{ id: string; name: string }> }>
    }
  } | null
}

const ITEMS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      projectItems(first: 50) {
        nodes { id project { id number owner { ... on Organization { login } ... on User { login } } } }
      }
    }
  }
}`

const FIELDS_QUERY = `query($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      fields(first: 100) {
        nodes { ... on ProjectV2SingleSelectField { id name options { id name } } }
      }
    }
  }
}`

const SET_FIELD_MUTATION = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) { projectV2Item { id } }
}`

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase()

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
  private readonly project?: ProjectRef
  private readonly resolveIssue: IssueRefResolver

  constructor(options: UpdateIssueActionOptions) {
    super({ id: options.id ?? 'update_issue' })
    this.client = options.client
    this.project = options.project
    this.resolveIssue = options.issue ?? issueFromPayload
  }

  async execute(input: UpdateIssueInput, ctx: PipelineExecutionContext): Promise<string> {
    const issue = this.resolveIssue(ctx)
    const changes: string[] = []
    const fields = { ...input.fields, ...(input.status ? { Status: input.status } : {}) }

    if (Object.keys(fields).length > 0) {
      await this.setProjectFields(issue, fields)
      changes.push(...Object.entries(fields).map(([name, value]) => `${name}=${value}`))
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

  private async setProjectFields(issue: IssueRef, fields: Record<string, string>): Promise<void> {
    const project = this.project
    if (!project) {
      throw new Error(
        'update_issue: status/fields necesitan un Project v2 — pasá `project` al construir la acción',
      )
    }
    issuePath(issue.owner, issue.repo, issue.number) // valida owner/repo/number antes de GraphQL

    const items = await this.client.graphql<ProjectItemsData>(ITEMS_QUERY, {
      owner: issue.owner,
      repo: issue.repo,
      number: issue.number,
    })
    const item = items.repository?.issue?.projectItems.nodes.find(
      (node) =>
        node.project.number === project.number && same(node.project.owner.login, project.owner),
    )
    if (!item) {
      throw new Error(
        `update_issue: ${issue.owner}/${issue.repo}#${issue.number} no está en el proyecto ${project.owner}#${project.number}`,
      )
    }

    const projectFields = await this.client.graphql<ProjectFieldsData>(FIELDS_QUERY, {
      projectId: item.project.id,
    })
    const available = projectFields.node?.fields.nodes ?? []
    for (const [name, value] of Object.entries(fields)) {
      const field = available.find((candidate) => same(candidate.name, name))
      if (!field?.id || !field.options) {
        throw new Error(`update_issue: el proyecto no tiene un campo single-select "${name}"`)
      }
      const option = field.options.find((candidate) => same(candidate.name, value))
      if (!option) {
        throw new Error(
          `update_issue: "${value}" no es una opción de "${field.name}" — opciones: ${field.options.map((o) => o.name).join(', ')}`,
        )
      }
      await this.client.graphql(SET_FIELD_MUTATION, {
        projectId: item.project.id,
        itemId: item.id,
        fieldId: field.id,
        optionId: option.id,
      })
    }
  }
}
