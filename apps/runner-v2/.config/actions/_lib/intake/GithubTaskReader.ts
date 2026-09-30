/**
 * Lo que `resolve_task` lee de GitHub, con la identidad del runner: el issue detrás de un item del
 * board, la card de un issue, un PR, los dependientes de un issue y el contexto de una task
 * (issue, blockers, timeline del issue y de su PR, CI). Sólo lecturas: devuelve lo que GitHub
 * contestó, y `task.ts` le da forma.
 */
import type { GithubClient } from '@ia-flow/github-api'
import { type OpenPr, openPr, type RawItem, type RawPr } from './task.js'
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

const LINKED_BRANCHES = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { linkedBranches(first: 10) { nodes { ref { name } } } }
  }
}`

// Las relaciones issue ↔ PR que GitHub ya lleva (sección "Development" y palabras de cierre): el
// intake las lee, no las deduce del nombre de una rama.
const CLOSING_ISSUES = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 10) { nodes { number repository { name owner { login } } } }
    }
  }
}`

const CLOSING_PRS = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number state } }
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
  openPr?: OpenPr
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

  /** Los issues que el PR cierra (su sección "Development"), en el orden que GitHub los da. */
  async closingIssues(
    owner: string,
    repo: string,
    number: number,
  ): Promise<Array<{ owner: string; repo: string; number: number }>> {
    const data = await this.client.graphql<{
      repository?: {
        pullRequest?: {
          closingIssuesReferences?: {
            nodes?: Array<{
              number: number
              repository: { name: string; owner: { login: string } }
            }>
          }
        } | null
      } | null
    }>(CLOSING_ISSUES, { owner, repo, number })
    return (data.repository?.pullRequest?.closingIssuesReferences?.nodes ?? []).map((node) => ({
      owner: node.repository.owner.login,
      repo: node.repository.name,
      number: node.number,
    }))
  }

  /** El PR abierto que cierra el issue (vinculado a mano o con `Closes #n`), si hay uno. */
  private async linkedOpenPr(owner: string, repo: string, number: number) {
    const data = await this.client.graphql<{
      repository?: {
        issue?: {
          closedByPullRequestsReferences?: { nodes?: Array<{ number: number; state: string }> }
        } | null
      } | null
    }>(CLOSING_PRS, { owner, repo, number })
    const nodes = data.repository?.issue?.closedByPullRequestsReferences?.nodes ?? []
    return nodes.find((node) => node.state === 'OPEN')?.number
  }

  pull(
    owner: string,
    repo: string,
    number: number,
  ): Promise<RawPr & { body?: string | null; head: { ref: string; sha: string } }> {
    return this.client.requestJson(`/repos/${owner}/${repo}/pulls/${number}`)
  }

  /** Las ramas vinculadas al issue (su sección "Development"): la de la task, si ya tiene una. */
  async linkedBranches(owner: string, repo: string, number: number): Promise<string[]> {
    const data = await this.client.graphql<{
      repository?: {
        issue?: { linkedBranches?: { nodes?: Array<{ ref?: { name: string } | null }> } } | null
      } | null
    }>(LINKED_BRANCHES, { owner, repo, number })
    return (data.repository?.issue?.linkedBranches?.nodes ?? [])
      .map((node) => node.ref?.name)
      .filter((name): name is string => Boolean(name))
  }

  /** Los issues que `owner/repo#number` bloquea (`mark_blocked_by`). */
  dependents(owner: string, repo: string, number: number) {
    return this.client.requestJson<
      Array<{ number: number; state: string; repository_url: string }>
    >(`/repos/${owner}/${repo}/issues/${number}/dependencies/blocking`)
  }

  /** El issue, sus blockers y su timeline; con PR abierto (el del evento, o el que GitHub dice que
   *  cierra el issue), el timeline del PR y su CI. */
  async context(task: {
    owner: string
    repo: string
    number: number
    pr?: number
  }): Promise<RawTaskContext> {
    const base = `/repos/${task.owner}/${task.repo}`
    const [issue, blockers, issueComments, pr] = await Promise.all([
      this.client.requestJson<RawTaskContext['issue']>(`${base}/issues/${task.number}`),
      this.client.requestJson<RawTaskContext['blockers']>(
        `${base}/issues/${task.number}/dependencies/blocked_by`,
      ),
      this.client.requestJson<RawComment[]>(`${base}/issues/${task.number}/comments?per_page=100`),
      this.openPr(task),
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

  /** El PR del evento si sigue abierto; si no trae uno, el que GitHub vincula al issue. */
  private async openPr(task: { owner: string; repo: string; number: number; pr?: number }) {
    const number = task.pr ?? (await this.linkedOpenPr(task.owner, task.repo, task.number))
    if (number === undefined) return undefined
    return openPr(await this.pull(task.owner, task.repo, number))
  }
}
