// GitHub REST — plain repo issues (no Projects v2 board involved).
//
// A single class facade over the issue-level GitHub calls this source needs.
// Delegates to the already-generic helpers in ../../github-project/api/*
// (client.ts/labels.ts/project.ts/linked-branches.ts are issue-scoped, not
// Project-scoped, so nothing here duplicates that logic) and adds only the
// REST calls a plain-issues source needs that GitHubProjectSource never did:
// listing/filtering a repo's issues by label, and the repo's label catalog.
//
// Wrapped in a class (not free functions) so GitHubIssueSource/
// GitHubIssueTaskSource can be unit-tested with a fake implementation
// instead of mocking `fetch` — see test/source.test.ts.
import { rest } from '../../github-project/api/client.js'
import { replaceIssueLabels } from '../../github-project/api/labels.js'
import { getPrimaryLinkedBranch } from '../../github-project/api/linked-branches.js'
import {
  type IssueComment,
  addBlockedBy,
  addIssueComment,
  createIssue,
  fetchIssueComments,
  getBlockingIssues,
  updateIssueBody,
} from '../../github-project/api/project.js'

export interface RestIssue {
  /** GraphQL node id — the stable id used everywhere else in the engine. */
  id: string
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
  assignees: string[]
  url: string
}

interface RawRestIssue {
  node_id: string
  number: number
  title: string
  body: string | null
  state: string
  labels: Array<string | { name: string }>
  assignees: Array<{ login: string }>
  html_url: string
  pull_request?: unknown
}

function mapIssue(raw: RawRestIssue): RestIssue {
  return {
    id: raw.node_id,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    labels: raw.labels.map((l) => (typeof l === 'string' ? l : l.name)),
    assignees: raw.assignees.map((a) => a.login),
    url: raw.html_url,
  }
}

export class GitHubIssuesApi {
  /** Issues in `owner/repo` carrying `label`. The `/issues` REST endpoint
   * also returns PRs — filtered out via the `pull_request` marker field. */
  async listByLabel(
    owner: string,
    repo: string,
    label: string,
    state: 'open' | 'closed' | 'all' = 'open',
  ): Promise<RestIssue[]> {
    const qs = new URLSearchParams({ labels: label, state, per_page: '100' })
    const raw = (await rest(`/repos/${owner}/${repo}/issues?${qs}`)) as RawRestIssue[]
    return raw.filter((i) => !i.pull_request).map(mapIssue)
  }

  async getByNumber(owner: string, repo: string, number: number): Promise<RestIssue | null> {
    try {
      const raw = (await rest(`/repos/${owner}/${repo}/issues/${number}`)) as RawRestIssue
      return mapIssue(raw)
    } catch {
      return null
    }
  }

  /** Full label catalog of the repo — feeds getStatuses() (labels with the
   * status prefix) without requiring the caller to have seen every label
   * on an already-fetched issue first. */
  async listRepoLabels(owner: string, repo: string): Promise<string[]> {
    const raw = (await rest(`/repos/${owner}/${repo}/labels?per_page=100`)) as Array<{
      name: string
    }>
    return raw.map((l) => l.name)
  }

  async replaceLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void> {
    await replaceIssueLabels(owner, repo, issueNumber, labels)
  }

  async create(owner: string, repo: string, title: string, body: string): Promise<RestIssue> {
    const created = await createIssue(owner, repo, title, body)
    return {
      id: created.id,
      number: created.number,
      title,
      body,
      state: 'open',
      labels: [],
      assignees: [],
      url: created.url,
    }
  }

  async addComment(issueNodeId: string, body: string): Promise<void> {
    await addIssueComment(issueNodeId, body)
  }

  async listComments(issueNodeId: string): Promise<IssueComment[]> {
    return fetchIssueComments(issueNodeId)
  }

  async updateBody(issueNodeId: string, body: string): Promise<void> {
    await updateIssueBody(issueNodeId, body)
  }

  async getBlockers(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<Array<{ number: number; state: string; title: string }>> {
    return getBlockingIssues(owner, repo, issueNumber)
  }

  async addBlockedBy(issueNodeId: string, blockingIssueNodeId: string): Promise<void> {
    await addBlockedBy(issueNodeId, blockingIssueNodeId)
  }

  async getLinkedBranch(
    issueNodeId: string,
    primaryRepoName: string | undefined,
  ): Promise<string | null> {
    return getPrimaryLinkedBranch(issueNodeId, primaryRepoName)
  }
}
