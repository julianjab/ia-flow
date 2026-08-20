// GitHub issue-level REST/GraphQL calls — no Projects v2 board involved.
// Shared by github-project/ (task-source.ts, source.ts read comments/blockers
// off the linked issue, not the board) and github-issues/ (the whole source
// IS these calls, no board layer on top). Anything that touches a
// ProjectV2/project item stays in github-project/api/project.ts instead.
import { gql, rest } from './client.js'

export interface IssueComment {
  id: string
  body: string
  created_at: string
}

// Exported: github-project/api/project.ts's markCommentsAsUsed appends this
// same marker to a comment body via a Project-side mutation.
export const USED_COMMENT_MARKER = '<!-- ia-flow:comment-used -->'

export async function fetchIssueComments(issueId: string): Promise<IssueComment[]> {
  const data = await gql<any>(
    `query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          comments(first: 50, orderBy: { field: UPDATED_AT, direction: ASC }) {
            nodes { id body createdAt }
          }
        }
      }
    }`,
    { issueId },
  )
  return (data.node.comments.nodes as any[])
    .filter((c) => !c.body?.includes('<!-- ia-flow:')) // skip system comments
    .filter((c) => !c.body?.includes(USED_COMMENT_MARKER)) // skip already-used
    .map((c) => ({ id: c.id, body: c.body as string, created_at: c.createdAt as string }))
}

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

export async function createIssue(
  owner: string,
  repo: string,
  title: string,
  body: string,
  // Optional: labels to apply at creation time. Needed by sources that
  // select issues purely by label (github-issues' anchorLabel/status:*) —
  // without this, a freshly created sub-issue would be invisible to the
  // engine until someone labeled it by hand. GitHub Projects v2 issues don't
  // need this (visibility there comes from add_to_project instead), so it's
  // optional and omitted when unset.
  labels?: string[],
): Promise<{ id: string; numericId: number; number: number; url: string }> {
  const data = (await rest(`/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: labels?.length ? { title, body, labels } : { title, body },
  })) as { id: number; node_id: string; number: number; html_url: string }
  return { id: data.node_id, numericId: data.id, number: data.number, url: data.html_url }
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
