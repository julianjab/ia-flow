/**
 * Lo que `resolve_task` lee de GitHub, con la identidad del runner: el issue detrás de un item del
 * board, la card de un issue, un PR, los dependientes de un issue y el contexto de una task
 * (issue, blockers, timeline del issue y de su PR, CI). Sólo lecturas: devuelve lo que GitHub
 * contestó, y `task.ts` le da forma.
 */
import type { GithubClient } from '@ia-tools/github-api'
import { openPr, type RawItem, type RawPr } from './task.js'
import type { RawComment, RawReview, RawThread } from './timeline.js'

export interface BoardRef {
  owner: string
  number: number
}

const PROJECT = 'project { number owner { ... on Organization { login } ... on User { login } } }'

const FIELD_VALUES = `fieldValues(first: 30) {
  nodes {
    ... on ProjectV2ItemFieldSingleSelectValue {
      name
      field { ... on ProjectV2SingleSelectField { name } }
    }
  }
}`

const ITEMS_OF_ISSUE = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { projectItems(first: 50) { nodes { id ${PROJECT} ${FIELD_VALUES} } } }
  }
}`

const ISSUE_OF_ITEM = `query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2Item {
      ${PROJECT}
      content { ... on Issue { number repository { name owner { login } } } }
    }
  }
}`

const REVIEW_THREADS = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(last: 30) {
        nodes {
          id isResolved path line
          comments(first: 20) { nodes { body createdAt author { login } } }
        }
      }
    }
  }
}`

/** Lo que el agente necesita de una task además de su card, tal cual lo devolvió GitHub. */
export interface RawTaskContext {
  issue: {
    title: string
    body?: string | null
    html_url: string
    labels: Array<{ name: string } | string>
  }
  blockers: Array<{ number: number; title: string; state: string; html_url: string }>
  issueComments: RawComment[]
  openPr?: { number: number; url: string; headSha: string }
  prComments?: RawComment[]
  threads?: RawThread[]
  reviews?: RawReview[]
  checks?: Array<{ status: string; conclusion: string | null }>
  statuses?: Array<{ state: string }>
}

type ItemIssue = Awaited<ReturnType<GithubTaskReader['readItem']>>

export class GithubTaskReader {
  private items?: Map<string, Promise<ItemIssue>>

  constructor(private readonly client: GithubClient) {}

  /** Un lector que lee cada item una sola vez: el de un webhook, que miran varios proyectos. */
  withItemCache(): GithubTaskReader {
    const reader = new GithubTaskReader(this.client)
    reader.items = new Map()
    return reader
  }

  /** El issue que envuelve un item del board, y de qué board es el item. */
  issueOfItem(itemId: string): Promise<ItemIssue> {
    const cached = this.items?.get(itemId)
    if (cached) return cached
    const read = this.readItem(itemId)
    this.items?.set(itemId, read)
    return read
  }

  private async readItem(itemId: string) {
    const data = await this.client.graphql<{
      node: {
        project?: { number: number; owner?: { login?: string } }
        content?: { number?: number; repository?: { name: string; owner: { login: string } } }
      } | null
    }>(ISSUE_OF_ITEM, { id: itemId })
    const { project, content } = data.node ?? {}
    if (!project || content?.number === undefined || !content.repository) return undefined
    return {
      board: { owner: project.owner?.login ?? '', number: project.number },
      owner: content.repository.owner.login,
      repo: content.repository.name,
      number: content.number,
    }
  }

  /** Los items del board de un issue (uno por board en el que está). */
  async itemsOfIssue(owner: string, repo: string, number: number): Promise<RawItem[]> {
    const data = await this.client.graphql<{
      repository?: { issue?: { projectItems?: { nodes?: RawItem[] } } | null } | null
    }>(ITEMS_OF_ISSUE, { owner, repo, number })
    return data.repository?.issue?.projectItems?.nodes ?? []
  }

  pull(
    owner: string,
    repo: string,
    number: number,
  ): Promise<RawPr & { body?: string | null; head: { ref: string; sha: string } }> {
    return this.client.requestJson(`/repos/${owner}/${repo}/pulls/${number}`)
  }

  /** Los issues que `owner/repo#number` bloquea (`mark_blocked_by`). */
  dependents(owner: string, repo: string, number: number) {
    return this.client.requestJson<
      Array<{ number: number; state: string; repository_url: string }>
    >(`/repos/${owner}/${repo}/issues/${number}/dependencies/blocking`)
  }

  /** El issue, sus blockers y su timeline; con PR abierto (el del evento, o el de su rama), el
   *  timeline del PR y su CI. */
  async context(task: {
    owner: string
    repo: string
    number: number
    pr?: number
    branch: string
  }): Promise<RawTaskContext> {
    const base = `/repos/${task.owner}/${task.repo}`
    const [issue, blockers, issueComments, pr] = await Promise.all([
      this.client.requestJson<RawTaskContext['issue']>(`${base}/issues/${task.number}`),
      this.client.requestJson<RawTaskContext['blockers']>(
        `${base}/issues/${task.number}/dependencies/blocked_by`,
      ),
      this.client.requestJson<RawComment[]>(`${base}/issues/${task.number}/comments?per_page=100`),
      this.openPr(base, task),
    ])
    if (!pr) return { issue, blockers, issueComments }
    const [prComments, threads, reviews, checks, status] = await Promise.all([
      this.client.requestJson<RawComment[]>(`${base}/issues/${pr.number}/comments?per_page=100`),
      this.client.graphql<{
        repository?: { pullRequest?: { reviewThreads?: { nodes?: RawThread[] } } | null } | null
      }>(REVIEW_THREADS, { owner: task.owner, repo: task.repo, number: pr.number }),
      this.client.requestJson<RawReview[]>(`${base}/pulls/${pr.number}/reviews?per_page=100`),
      this.client.requestJson<{ check_runs: NonNullable<RawTaskContext['checks']> }>(
        `${base}/commits/${pr.headSha}/check-runs?per_page=100`,
      ),
      this.client.requestJson<{ statuses: NonNullable<RawTaskContext['statuses']> }>(
        `${base}/commits/${pr.headSha}/status`,
      ),
    ])
    return {
      issue,
      blockers,
      issueComments,
      openPr: pr,
      prComments,
      threads: threads.repository?.pullRequest?.reviewThreads?.nodes ?? [],
      reviews,
      checks: checks.check_runs,
      statuses: status.statuses,
    }
  }

  /** El PR del evento si sigue abierto; si no trae uno, el abierto desde la rama de la task. */
  private async openPr(base: string, task: { owner: string; pr?: number; branch: string }) {
    if (task.pr !== undefined) {
      return openPr(await this.client.requestJson<RawPr>(`${base}/pulls/${task.pr}`), undefined)
    }
    const head = encodeURIComponent(`${task.owner}:${task.branch}`)
    return openPr(
      undefined,
      await this.client.requestJson<RawPr[]>(`${base}/pulls?state=open&head=${head}`),
    )
  }
}
