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

// Appended to a human comment's body (see markCommentsUsed below) once a run
// has read it via `{{task.comments}}`, so the next run doesn't see it again.
export const USED_COMMENT_MARKER = '<!-- ia-flow:comment-used -->'

// Appended to the engine's OWN comments (complete_task/fail_task/postError/
// add_task_comment — see task-source.ts postComment/postError in both
// github-project and github-issues) so they never come back as
// `{{task.comments}}` "human feedback" on a later run of the same task. Any
// marker starting with `<!-- ia-flow:` is filtered out below, so this and
// USED_COMMENT_MARKER share the same prefix by design.
export const SYSTEM_COMMENT_MARKER = '<!-- ia-flow:system-comment -->'

export async function fetchIssueComments(issueId: string): Promise<IssueComment[]> {
  // DESC + first:50 so the window is the 50 MOST RECENT comments, not the 50
  // oldest — with ASC (the previous order), an issue with a long history of
  // engine status comments (all system-tagged, now filtered post-fetch)
  // could fill the entire page with noise and push the one fresh human
  // comment `{{task.comments}}` actually needs outside the fetched window,
  // rendering empty right when there's real feedback to read. Reversed back
  // to chronological (oldest→newest) after filtering, since that's the order
  // formatComments (apps/server/src/variables/task.ts) renders in.
  const data = await gql<any>(
    `query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          comments(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
            nodes { id body createdAt }
          }
        }
      }
    }`,
    { issueId },
  )
  return (data.node.comments.nodes as any[])
    .filter((c) => !c.body?.includes('<!-- ia-flow:')) // skip system + already-used comments
    .map((c) => ({ id: c.id, body: c.body as string, created_at: c.createdAt as string }))
    .reverse()
}

/**
 * Marks human comments as "read" so they stop showing up in `{{task.comments}}`
 * on subsequent runs of the same task — without this, a piece of feedback left
 * once gets re-injected into every future retry indefinitely. Appends the
 * marker to each comment's OWN current body (passed in by the caller, who just
 * loaded them) — an earlier version of this replaced the whole body with just
 * the marker, silently destroying the original text.
 */
export async function markCommentsUsed(
  comments: Array<{ id: string; body: string }>,
): Promise<void> {
  await Promise.all(
    comments.map((c) =>
      gql(
        `mutation($id: ID!, $body: String!) {
          updateIssueComment(input: { id: $id, body: $body }) {
            issueComment { id }
          }
        }`,
        { id: c.id, body: `${c.body}\n\n${USED_COMMENT_MARKER}` },
      ).catch(() => {
        /* best-effort — a comment that fails to get marked just gets re-read
         * next run, not lost */
      }),
    ),
  )
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
