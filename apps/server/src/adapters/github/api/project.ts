// GitHub Projects v2 — project + item management via GraphQL
import { gql, rest } from './client.js'

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

export async function listProjectItems(
  projectId: string,
  fields: Record<string, ProjectField>,
  statusFilter?: string,
): Promise<ProjectItem[]> {
  const statusFieldId = fields['Status']?.id
  const typeFieldId = fields['Task Type']?.id
  const reposFieldId = fields['Repos']?.id
  const priorityFieldId = fields['Priority']?.id
  const sizeFieldId = fields['Size']?.id
  const workingFieldId = fields['Working']?.id

  // Fetch up to 100 items at a time (pagination omitted for now — add if needed)
  const query = `query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100) {
          nodes {
            id
            content {
              ... on Issue {
                id
                number
                title
                body
                repository { name }
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
            }
          }
        }
      }
    }
  }`

  const data = await gql<any>(query, { projectId })
  const rawItems: any[] = data.node.items.nodes

  const items: ProjectItem[] = []
  for (const raw of rawItems) {
    if (!raw.content?.number) continue // skip drafts

    const fieldMap: Record<string, string> = {}
    for (const fv of raw.fieldValues.nodes) {
      const fieldName = fv.field?.name
      if (fieldName) fieldMap[fieldName] = fv.name ?? fv.text ?? ''
    }

    const item: ProjectItem = {
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
    }

    if (!statusFilter || item.status.toLowerCase() === statusFilter.toLowerCase()) {
      items.push(item)
    }
  }

  return items
}

// ─── Fetch issue comments ────────────────────────────────────────────────

export interface IssueComment {
  id: string
  body: string
}

const USED_COMMENT_MARKER = '<!-- ia-flow:comment-used -->'

export async function fetchIssueComments(issueId: string): Promise<IssueComment[]> {
  const data = await gql<any>(
    `query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          comments(first: 50, orderBy: { field: UPDATED_AT, direction: ASC }) {
            nodes { id body }
          }
        }
      }
    }`,
    { issueId },
  )
  return (data.node.comments.nodes as any[])
    .filter((c) => !c.body?.includes('<!-- ia-flow:')) // skip system comments
    .filter((c) => !c.body?.includes(USED_COMMENT_MARKER)) // skip already-used
    .map((c) => ({ id: c.id, body: c.body as string }))
}

export async function markCommentsAsUsed(commentIds: string[]): Promise<void> {
  await Promise.all(
    commentIds.map((id) =>
      gql(
        `mutation($id: ID!, $body: String!) {
          updateIssueComment(input: { id: $id, body: $body }) {
            issueComment { id }
          }
        }`,
        // Append invisible marker to original body — comment remains readable
        { id, body: `${USED_COMMENT_MARKER}` },
      ).catch(() => {
        /* best-effort */
      }),
    ),
  )
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

// ─── Update GitHub issue body ─────────────────────────────────────────────

export async function updateIssueBody(issueId: string, newBody: string): Promise<void> {
  await gql(
    `mutation($issueId: ID!, $body: String!) {
      updateIssue(input: { id: $issueId, body: $body }) {
        issue { id }
      }
    }`,
    { issueId, body: newBody },
  )
}

// ─── Add comment to issue ─────────────────────────────────────────────────

export async function addIssueComment(issueId: string, body: string): Promise<string> {
  const data = await gql<any>(
    `mutation($issueId: ID!, $body: String!) {
      addComment(input: { subjectId: $issueId, body: $body }) {
        commentEdge { node { id } }
      }
    }`,
    { issueId, body },
  )
  return data.addComment.commentEdge.node.id
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

// ─── Create a GitHub issue ────────────────────────────────────────────────

export async function createIssue(
  owner: string,
  repo: string,
  title: string,
  body: string,
): Promise<{ id: string; numericId: number; number: number; url: string }> {
  const data = (await rest(`/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: { title, body },
  })) as { id: number; node_id: string; number: number; html_url: string }
  return { id: data.node_id, numericId: data.id, number: data.number, url: data.html_url }
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

// ─── Link a sub-issue to a parent issue (GitHub native sub-issues) ────────

export async function addSubIssue(
  owner: string,
  repo: string,
  parentNumber: number,
  childNumericId: number,
): Promise<void> {
  await rest(`/repos/${owner}/${repo}/issues/${parentNumber}/sub_issues`, {
    method: 'POST',
    body: { sub_issue_id: childNumericId },
  })
}

// ─── Issue dependencies (blocked by / blocking) ───────────────────────────

export async function addBlockedBy(
  issueNodeId: string,
  blockingIssueNodeId: string,
): Promise<void> {
  await gql(
    `mutation($issueId: ID!, $blockingIssueId: ID!) {
      addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
        issue { id }
      }
    }`,
    { issueId: issueNodeId, blockingIssueId: blockingIssueNodeId },
  )
}

export async function getBlockingIssues(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<Array<{ number: number; state: string; title: string }>> {
  const data = (await rest(
    `/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
  )) as any[]
  return (data ?? []).map((i: any) => ({ number: i.number, state: i.state, title: i.title }))
}
