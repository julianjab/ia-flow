// GitHub REST — plain repo issues (no Projects v2 board involved).
//
// A single class facade over the issue-level GitHub calls this source needs.
// Delegates to the already-generic helpers in ../../github-shared/*
// (client.ts/labels.ts/linked-branches.ts/issue.ts have no Project-v2
// coupling, so nothing here duplicates that logic — see github-project/api/
// for what's actually board-specific) and adds only the REST calls a
// plain-issues source needs that GitHubProjectSource never did:
// listing/filtering a repo's issues by label, and the repo's label catalog.
//
// Wrapped in a class (not free functions) so GitHubIssueSource/
// GitHubIssueTaskSource can be unit-tested with a fake implementation
// instead of mocking `fetch` — see test/source.test.ts.
import { gql, isNodeNotFoundError, rest } from '../../github-shared/client.js'
import { type IssueDevLinks, fetchIssueDevLinks } from '../../github-shared/dev-links.js'
import {
  type IssueComment,
  addBlockedBy,
  addIssueComment,
  createIssue,
  fetchIssueComments,
  getBlockingIssues,
  updateIssueBody,
} from '../../github-shared/issue.js'
import { replaceIssueLabels } from '../../github-shared/labels.js'
import { createLogger } from '../../logger.js'

const log = createLogger('github-issues-api')

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

/**
 * Build a RestIssue directly from a GitHub `issues`/`issue_comment` webhook
 * delivery's `payload.issue` — same shape as RawRestIssue (node_id, number,
 * labels[].name, assignees[].login, html_url), so no request is needed for
 * the common webhook case. Returns null when the payload doesn't carry an
 * issue object or is missing a required field — callers fall back to
 * `getByNumber`/`getById`.
 */
export function fromWebhookPayload(payload: Record<string, unknown>): RestIssue | null {
  const issue = payload.issue as Partial<RawRestIssue> | undefined
  if (!issue || typeof issue.node_id !== 'string' || typeof issue.number !== 'number') return null
  if (typeof issue.title !== 'string' || !Array.isArray(issue.labels)) return null
  return mapIssue(issue as RawRestIssue)
}

interface GqlIssueNode {
  id: string
  number: number
  title: string
  body: string | null
  state: string
  url: string
  labels: { nodes: Array<{ name: string }> }
  assignees: { nodes: Array<{ login: string }> }
}

const ISSUE_BY_ID_QUERY = `
  query IssueById($id: ID!) {
    node(id: $id) {
      ... on Issue {
        id
        number
        title
        body
        state
        url
        labels(first: 100) { nodes { name } }
        assignees(first: 100) { nodes { login } }
      }
    }
  }
`

function mapGqlIssue(node: GqlIssueNode): RestIssue {
  return {
    id: node.id,
    number: node.number,
    title: node.title,
    body: node.body ?? '',
    state: node.state === 'CLOSED' ? 'closed' : 'open',
    labels: node.labels.nodes.map((l) => l.name),
    assignees: node.assignees.nodes.map((a) => a.login),
    url: node.url,
  }
}

// GitHub REST pages at up to 100 items. A hard cap (not "loop until GitHub
// says stop") bounds worst-case request count if a filter is too broad —
// 20 pages = 2000 items is already far more than a sane anchor label should
// ever match; a repo hitting the cap needs a narrower label, not a client
// that pages forever. Hitting it is logged (not silent): the alternative is
// issues past page 20 quietly vanishing from the engine with no signal.
const MAX_PAGES = 20
const PAGE_SIZE = 100

async function fetchAllPages<T>(pageUrl: (page: number) => string, context: string): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const chunk = (await rest(pageUrl(page))) as T[]
    all.push(...chunk)
    if (chunk.length < PAGE_SIZE) return all
  }
  log.warn(
    { context, fetched: all.length, maxPages: MAX_PAGES },
    'Pagination cap hit — results may be truncated',
  )
  return all
}

/** `rest()` throws a plain Error with the status baked into the message
 * (`GitHub REST GET <path> → <status>: <body>`) — no typed status field to
 * branch on. Parsed here rather than adding a typed error to the shared
 * client just for this one call site. */
function is404(err: unknown): boolean {
  return err instanceof Error && / → 404:/.test(err.message)
}

export class GitHubIssuesApi {
  /** Issues in `owner/repo`, optionally narrowed to those carrying `label`.
   * Omitting `label` lists EVERY issue in the given state — that's the
   * anchor-less mode of GitHubIssueSource (see its `anchorLabel`), not an
   * accident, so the `labels` query param is dropped rather than sent empty
   * (GitHub treats `labels=` as "no label matches" and returns nothing).
   * The `/issues` REST endpoint also returns PRs — filtered out via the
   * `pull_request` marker field. */
  async listIssues(
    owner: string,
    repo: string,
    label?: string,
    state: 'open' | 'closed' | 'all' = 'open',
  ): Promise<RestIssue[]> {
    const raw = await fetchAllPages<RawRestIssue>(
      (page) =>
        `/repos/${owner}/${repo}/issues?${new URLSearchParams({
          ...(label ? { labels: label } : {}),
          state,
          per_page: String(PAGE_SIZE),
          page: String(page),
        })}`,
      `listIssues(${owner}/${repo}${label ? `, ${label}` : ''})`,
    )
    return raw
      .filter((i) => {
        if (!i.pull_request) return true
        log.debug(
          { owner, repo, number: i.number },
          `Skipping ${owner}/${repo}#${i.number} — it is a pull request, not an issue`,
        )
        return false
      })
      .map(mapIssue)
  }

  /** `null` only for a genuine 404 (issue deleted/transferred) — any other
   * failure (5xx, rate limit, network) throws, so callers that need a fresh
   * read to avoid clobbering labels (see GitHubIssueTaskSource.freshLabels)
   * don't silently fall back to a stale snapshot on a transient error. */
  async getByNumber(owner: string, repo: string, number: number): Promise<RestIssue | null> {
    try {
      const raw = (await rest(`/repos/${owner}/${repo}/issues/${number}`)) as RawRestIssue
      return mapIssue(raw)
    } catch (err) {
      if (is404(err)) return null
      throw err
    }
  }

  /**
   * Direct GraphQL `node(id)` lookup — the fast path DivergenceReconciler
   * and GitHubIssueSource.watch()'s payload-insufficient fallback need
   * (never a linear scan over listIssues). `null` for a deleted/transferred
   * issue or a node id that doesn't resolve to an Issue.
   */
  /** `null` también para un id que ya no resuelve: GitHub devuelve eso como
   *  error top-level `NOT_FOUND`, no como `data.node = null` — ver
   *  `isNodeNotFoundError`. */
  async getById(nodeId: string): Promise<RestIssue | null> {
    try {
      const data = await gql<{ node: GqlIssueNode | null }>(ISSUE_BY_ID_QUERY, { id: nodeId })
      return data.node ? mapGqlIssue(data.node) : null
    } catch (err) {
      if (isNodeNotFoundError(err)) return null
      throw err
    }
  }

  /** Full label catalog of the repo — feeds getStatuses() (labels with the
   * status prefix) without requiring the caller to have seen every label
   * on an already-fetched issue first. */
  async listRepoLabels(owner: string, repo: string): Promise<string[]> {
    const raw = await fetchAllPages<{ name: string }>(
      (page) => `/repos/${owner}/${repo}/labels?per_page=${PAGE_SIZE}&page=${page}`,
      `listRepoLabels(${owner}/${repo})`,
    )
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

  async updateBody(issueNodeId: string, body: string, title?: string): Promise<void> {
    await updateIssueBody(issueNodeId, body, title)
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

  /** Branch linkeada + PRs de VARIOS issues a la vez. Un request cada 100
   * ids (tope de `nodes(ids:)`), no uno por issue: es lo que permite mostrar
   * rama/PR en el listado sin multiplicar las llamadas a GitHub. */
  async getDevLinks(
    issueNodeIds: string[],
    primaryRepoName: string | undefined,
  ): Promise<Map<string, IssueDevLinks>> {
    return fetchIssueDevLinks(issueNodeIds, primaryRepoName)
  }
}
