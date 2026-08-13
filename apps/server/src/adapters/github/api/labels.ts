import { rest } from './client.js'

export async function addLabelsToIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  if (!labels.length) return
  await rest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: 'POST',
    body: { labels },
  })
}

/**
 * Removes a single label from an issue.
 *   DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}
 * GitHub returns 404 when the label is not applied to the issue; that surfaces
 * as a thrown error from `rest`. Callers that expect idempotent removal must
 * handle it explicitly.
 */
export async function removeLabelFromIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  await rest(
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    { method: 'DELETE' },
  )
}

/**
 * Replaces all labels on an issue with the given set (PUT semantics).
 *   PUT /repos/{owner}/{repo}/issues/{issue_number}/labels
 * Passing an empty array clears every label from the issue.
 */
export async function setLabelsOnIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  await rest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: 'PUT',
    body: { labels },
  })
}
