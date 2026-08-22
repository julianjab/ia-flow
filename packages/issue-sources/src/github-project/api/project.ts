// GitHub Projects v2 — project + item management via GraphQL. Issue-level
// calls that don't touch a project item (comments, body, blockers, sub-issue
// links) live in ../../github-shared/issue.ts and are re-imported below only
// where this file's own Project-specific flows still need them
// (upsertValidationComment → addIssueComment).
import { gql } from '../../github-shared/client.js'
import {
  type PullRequestRef,
  issueDevLinksSelection,
  mapDevLinks,
  withDevLinksFallback,
} from '../../github-shared/dev-links.js'
import { addIssueComment } from '../../github-shared/issue.js'

export interface ProjectField {
  id: string
  name?: string
  dataType?: string
  options?: Array<{ id: string; name: string }>
}

export interface ProjectItem {
  id: string // node id of the project item
  issueId: string // node id of the linked issue
  issueNumber: number
  issueTitle: string
  issueBody: string
  repoName: string
  status: string // value of the Status field
  type: string // value of the Type field
  repos: string // value of the Repos field (comma-separated)
  priority: string
  size: string
  working: boolean
  // GitHub issue labels (name only).
  labels: string[]
  // GitHub issue assignees (login only).
  assignees: string[]
  // All Project custom-field values keyed by upstream name (e.g. "ImpProvider",
  // "Reviewed", "Stage"). Exposed so agent `when` conditions can filter on any
  // field without a schema change on this end.
  fields: Record<string, string>
  // Nombre de la branch git linkeada al issue vía el Development panel
  // (`linkedBranches`). Undefined si no hay ninguna aún. Cuando el issue tiene
  // varias, se elige la del repo primario de la task.
  linkedBranch?: string
  // Repo dueño de `linkedBranch` (puede no ser el repo del issue).
  linkedBranchRepo?: string
  // PRs que cierran el issue (`closedByPullRequestsReferences`), incluidos los
  // ya cerrados/mergeados. Vacío cuando no hay ninguno — o cuando el endpoint
  // no soporta el campo (ver withDevLinksFallback).
  pullRequests: PullRequestRef[]
}

export interface ProjectMeta {
  projectId: string
  owner: string // org or user login
  fields: Record<string, ProjectField> // keyed by field name
}

// ─── Read project metadata ─────────────────────────────────────────────────

export async function getProjectMeta(projectUrl: string): Promise<ProjectMeta> {
  // projectUrl format: https://github.com/orgs/la-haus/projects/42
  const match = projectUrl.match(/\/projects\/(\d+)/)
  if (!match) throw new Error(`Invalid project URL: ${projectUrl}`)
  const projectNumber = parseInt(match[1], 10)

  // Detect org vs user project
  const orgMatch = projectUrl.match(/\/orgs\/([^/]+)\//)
  const userMatch = projectUrl.match(/\/users\/([^/]+)\//)
  const owner = orgMatch?.[1] ?? userMatch?.[1]
  if (!owner) throw new Error(`Cannot extract owner from project URL: ${projectUrl}`)

  const isOrg = !!orgMatch

  const query = isOrg
    ? `query($org: String!, $num: Int!) {
        organization(login: $org) {
          projectV2(number: $num) {
            id
            fields(first: 20) {
              nodes {
                ... on ProjectV2Field { id name dataType }
                ... on ProjectV2SingleSelectField { id name dataType options { id name } }
              }
            }
          }
        }
      }`
    : `query($user: String!, $num: Int!) {
        user(login: $user) {
          projectV2(number: $num) {
            id
            fields(first: 20) {
              nodes {
                ... on ProjectV2Field { id name dataType }
                ... on ProjectV2SingleSelectField { id name dataType options { id name } }
              }
            }
          }
        }
      }`

  const variables = isOrg ? { org: owner, num: projectNumber } : { user: owner, num: projectNumber }

  const data = await gql<Record<string, unknown>>(query, variables)
  const proj = isOrg ? (data as any).organization.projectV2 : (data as any).user.projectV2

  const fields: Record<string, ProjectField> = {}
  for (const node of proj.fields.nodes) {
    if (node?.name) fields[node.name] = node
  }

  return { projectId: proj.id, owner, fields }
}

// ─── List project items filtered by status ────────────────────────────────

// Shared GraphQL selection for a ProjectV2Item's content — used both by the
// bulk `items(first: 100)` query below and by getProjectItemById's single
// `node(id)` lookup, so the two never drift out of sync.
function projectItemNodeFields(): string {
  return `
  id
  content {
    ... on Issue {
      id
      number
      title
      body
      repository { name }
      labels(first: 20) { nodes { name } }
      assignees(first: 10) { nodes { login } }
      # Development panel de GitHub: branch linkeada + PRs que cierran el
      # issue. La selección la arma github-shared/dev-links para que este
      # bulk y GitHubIssueSource pidan exactamente los mismos campos.
      ${issueDevLinksSelection()}
    }
  }
  fieldValues(first: 20) {
    nodes {
      ... on ProjectV2ItemFieldSingleSelectValue {
        field { ... on ProjectV2SingleSelectField { id name } }
        name
      }
      ... on ProjectV2ItemFieldTextValue {
        field { ... on ProjectV2Field { id name } }
        text
      }
    }
  }`
}

/**
 * Maps one raw ProjectV2Item GraphQL node (the shape projectItemNodeFields()
 * selects) to a ProjectItem. `null` for a draft (no linked issue yet — the
 * daemon only tracks real issues) or a node that no longer resolves (deleted
 * item — `node(id)` returns `null` for those, same as `raw` here).
 * Exported for tests.
 */
export function mapProjectItemNode(raw: any): ProjectItem | null {
  if (!raw?.content?.number) return null

  const fieldMap: Record<string, string> = {}
  for (const fv of raw.fieldValues.nodes) {
    const fieldName = fv.field?.name
    if (fieldName) fieldMap[fieldName] = fv.name ?? fv.text ?? ''
  }

  const labels: string[] = (raw.content.labels?.nodes ?? [])
    .map((n: { name?: string }) => n?.name ?? '')
    .filter(Boolean)
  const assignees: string[] = (raw.content.assignees?.nodes ?? [])
    .map((n: { login?: string }) => n?.login ?? '')
    .filter(Boolean)

  // Branch linkeada + PRs que cierran el issue. El mapper es compartido con
  // GitHubIssueSource (github-shared/dev-links) — acá los datos ya vienen
  // dentro del bulk, así que no cuestan un request extra.
  const primaryRepoName: string = raw.content.repository?.name ?? ''
  const devLinks = mapDevLinks(raw.content, primaryRepoName)

  return {
    id: raw.id,
    issueId: raw.content.id,
    issueNumber: raw.content.number,
    issueTitle: raw.content.title,
    issueBody: raw.content.body ?? '',
    repoName: raw.content.repository?.name ?? '',
    status: fieldMap['Status'] ?? '',
    type: fieldMap['Task Type'] ?? '',
    repos: fieldMap['Repos'] ?? '',
    priority: fieldMap['Priority'] ?? '',
    size: fieldMap['Size'] ?? '',
    working: fieldMap['Working']?.toLowerCase() === 'yes',
    labels,
    assignees,
    fields: fieldMap,
    linkedBranch: devLinks.branch,
    linkedBranchRepo: devLinks.branchRepo,
    pullRequests: devLinks.pullRequests,
  }
}

export async function listProjectItems(
  projectId: string,
  _fields: Record<string, ProjectField>,
  statusFilter?: string,
): Promise<ProjectItem[]> {
  // Fetch up to 100 items at a time (pagination omitted for now — add if needed)
  // La query se arma DENTRO del closure: si el endpoint no soporta el campo de
  // PRs, withDevLinksFallback reintenta y el segundo intento tiene que
  // regenerar la selección ya sin ese campo.
  const data = await withDevLinksFallback(() =>
    gql<any>(
      `query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100) {
              nodes {
                ${projectItemNodeFields()}
              }
            }
          }
        }
      }`,
      { projectId },
    ),
  )
  const rawItems: any[] = data.node.items.nodes

  const items: ProjectItem[] = []
  for (const raw of rawItems) {
    const item = mapProjectItemNode(raw)
    if (!item) continue // skip drafts
    if (!statusFilter || item.status.toLowerCase() === statusFilter.toLowerCase()) {
      items.push(item)
    }
  }

  return items
}

/**
 * Direct `node(id)` lookup for a single ProjectV2Item — the fast path
 * DivergenceReconciler and GitHubProjectSource.watch()'s `projects_v2_item`
 * event both need (never a linear scan over listProjectItems). `null` for a
 * deleted item, a draft with no linked issue yet, or a node id that isn't a
 * ProjectV2Item at all.
 */
export async function getProjectItemById(itemId: string): Promise<ProjectItem | null> {
  const data = await withDevLinksFallback(() =>
    gql<any>(
      `query($itemId: ID!) {
        node(id: $itemId) {
          ... on ProjectV2Item {
            ${projectItemNodeFields()}
          }
        }
      }`,
      { itemId },
    ),
  )
  return mapProjectItemNode(data.node)
}

// ─── Update project item status ───────────────────────────────────────────

export async function updateItemStatus(
  projectId: string,
  itemId: string,
  statusField: ProjectField,
  newStatus: string,
): Promise<void> {
  const option = statusField.options?.find((o) => o.name.toLowerCase() === newStatus.toLowerCase())
  if (!option) {
    const available = statusField.options?.map((o) => o.name).join(', ') ?? 'none'
    throw new Error(
      `Status option '${newStatus}' not found in field '${statusField.name}'. Available: ${available}`,
    )
  }

  await gql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`,
    {
      projectId,
      itemId,
      fieldId: statusField.id,
      optionId: option.id,
    },
  )
}

// ─── Update existing comment ──────────────────────────────────────────────

export async function updateComment(commentId: string, body: string): Promise<void> {
  await gql(
    `mutation($commentId: ID!, $body: String!) {
      updateIssueComment(input: { id: $commentId, body: $body }) {
        issueComment { id }
      }
    }`,
    { commentId, body },
  )
}

// ─── Delete comment ───────────────────────────────────────────────────────

export async function deleteComment(commentId: string): Promise<void> {
  await gql(
    `mutation($commentId: ID!) {
      deleteIssueComment(input: { id: $commentId }) { clientMutationId }
    }`,
    { commentId },
  )
}

// ─── Find ia-flow validation comment in an issue ─────────────────────────
// Returns the comment node id if found, null otherwise

const VALIDATION_MARKER = '<!-- ia-flow:validation -->'

export async function findValidationComment(issueId: string): Promise<string | null> {
  const data = await gql<any>(
    `query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          comments(first: 50) {
            nodes { id body }
          }
        }
      }
    }`,
    { issueId },
  )
  const comment = data.node.comments.nodes.find((c: any) => c.body?.includes(VALIDATION_MARKER))
  return comment?.id ?? null
}

// ─── Upsert validation comment (create or overwrite) ─────────────────────

export async function upsertValidationComment(issueId: string, body: string): Promise<void> {
  const full = `${VALIDATION_MARKER}\n${body}`
  const existing = await findValidationComment(issueId)
  if (existing) {
    await updateComment(existing, full)
  } else {
    await addIssueComment(issueId, full)
  }
}

// ─── Remove validation comment when issue is ready to process ────────────

export async function clearValidationComment(issueId: string): Promise<void> {
  const existing = await findValidationComment(issueId)
  if (existing) await deleteComment(existing)
}

// ─── Create a draft issue directly on a GitHub Project ───────────────────
// Draft issues live on the project board without a backing repo issue. Used
// by the provider-agnostic task creation route so callers can queue work
// without picking a repo up-front.

export async function createProjectDraftIssue(
  projectId: string,
  title: string,
  body: string,
): Promise<{ itemId: string; draftIssueId: string; databaseId: number }> {
  const data = await gql<any>(
    `mutation($projectId: ID!, $title: String!, $body: String!) {
      addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
        projectItem {
          id
          databaseId
          content { ... on DraftIssue { id } }
        }
      }
    }`,
    { projectId, title, body },
  )
  const item = data.addProjectV2DraftIssue.projectItem
  return { itemId: item.id, draftIssueId: item.content.id, databaseId: item.databaseId }
}

// Update the title/body of an existing draft issue. `draftIssueId` is the
// DraftIssue node id (not the project item id).

export async function updateProjectDraftIssue(
  draftIssueId: string,
  patch: { title?: string; body?: string },
): Promise<void> {
  await gql(
    `mutation($id: ID!, $title: String, $body: String) {
      updateProjectV2DraftIssue(input: { draftIssueId: $id, title: $title, body: $body }) {
        draftIssue { id }
      }
    }`,
    { id: draftIssueId, title: patch.title ?? null, body: patch.body ?? null },
  )
}

// Remove an item (draft or linked issue) from the project board.

export async function deleteProjectItem(projectId: string, itemId: string): Promise<void> {
  await gql(
    `mutation($projectId: ID!, $itemId: ID!) {
      deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
        deletedItemId
      }
    }`,
    { projectId, itemId },
  )
}

// ─── Add issue to a GitHub Project ───────────────────────────────────────

export async function addProjectItem(
  projectId: string,
  issueId: string,
): Promise<{ itemId: string }> {
  const data = await gql<any>(
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }`,
    { projectId, contentId: issueId },
  )
  return { itemId: data.addProjectV2ItemById.item.id }
}

// ─── Set a text project field on an item ─────────────────────────────────

export async function setProjectTextField(
  projectId: string,
  itemId: string,
  field: ProjectField,
  text: string,
): Promise<void> {
  await gql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { text: $text }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId: field.id, text },
  )
}

// ─── Clear a single-select project field on an item ──────────────────────

export async function clearItemWorking(
  projectId: string,
  itemId: string,
  field: ProjectField,
): Promise<void> {
  await gql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      clearProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId: field.id },
  )
}

// ─── Remove options from a single-select field (e.g. Status) ─────────────
// GitHub Projects v2: updateProjectV2Field replaces options with the given list.
// Options NOT in the new list are deleted. Items with a deleted option lose that value.

export async function removeStatusOptions(
  _projectId: string,
  field: ProjectField,
  namesToRemove: string[],
): Promise<void> {
  if (!field.options) return
  const toRemoveSet = new Set(namesToRemove.map((n) => n.toLowerCase()))
  const remaining = field.options.filter((o) => !toRemoveSet.has(o.name.toLowerCase()))
  if (remaining.length === field.options.length) return // nothing to remove

  await gql(
    `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
      updateProjectV2Field(input: {
        fieldId: $fieldId
        singleSelectOptions: $options
      }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
    }`,
    {
      fieldId: field.id,
      options: remaining.map((o) => ({ name: o.name, color: 'GRAY', description: '' })),
    },
  )
}

// Fresh read of a single-select field's value on a Project item. Bypasses
// any items cache the source layer keeps — used by orchestration guards
// that must observe writes done milliseconds ago (e.g. set_task_field on
// Status inside the prompt) without waiting for the poll TTL to expire.
export async function getItemSingleSelectValue(
  itemId: string,
  fieldName: string,
): Promise<string | null> {
  const data = await gql<any>(
    `query($id: ID!, $name: String!) {
      node(id: $id) {
        ... on ProjectV2Item {
          fieldValueByName(name: $name) {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }`,
    { id: itemId, name: fieldName },
  )
  const name = data?.node?.fieldValueByName?.name
  return typeof name === 'string' ? name : null
}
