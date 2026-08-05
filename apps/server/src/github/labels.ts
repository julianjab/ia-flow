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
