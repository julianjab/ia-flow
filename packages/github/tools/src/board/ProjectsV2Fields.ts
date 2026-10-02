import type { GithubClient } from '@ia-flow/github-api'
import { issuePath } from '../shared.js'
import type { BoardWriter, IssueRef, ProjectRef } from './types.js'

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

const CLEAR_FIELD_MUTATION = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) {
    projectV2Item { id }
  }
}`

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase()

/**
 * Escribe los campos single-select de la card de un issue en un Project v2. Los nombres de campos
 * y opciones se comparan sin distinguir mayúsculas, igual que el `$set:status=Build` de ia-flow.
 * Los mensajes de error empiezan con `update_issue:` porque llegan tal cual al reporte de un
 * agente.
 */
export class ProjectsV2Fields implements BoardWriter {
  constructor(
    private readonly client: GithubClient,
    private readonly project: ProjectRef,
  ) {}

  async setFields(
    issue: IssueRef,
    fields: Record<string, string>,
    clear: string[] = [],
  ): Promise<void> {
    const project = this.project
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
    for (const name of clear) {
      const field = available.find((candidate) => same(candidate.name, name))
      if (!field?.id) throw new Error(`update_issue: el proyecto no tiene un campo "${name}"`)
      await this.client.graphql(CLEAR_FIELD_MUTATION, {
        projectId: item.project.id,
        itemId: item.id,
        fieldId: field.id,
      })
    }
  }
}
