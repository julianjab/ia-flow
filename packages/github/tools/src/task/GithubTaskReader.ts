/**
 * Lo que `resolve_task` lee de GitHub, con la identidad del runner: el issue detrás de un item del
 * board, la card de un issue, un PR, los dependientes de un issue y el contexto de una task
 * (issue, blockers, timeline del issue y de su PR, CI). Sólo lecturas: devuelve lo que GitHub
 * contestó, y `task.ts` le da forma.
 */
import type { GithubClient } from '@ia-flow/github-api'
import { sameRepo } from '../shared.js'
import {
  CLOSING_ISSUES,
  CLOSING_PRS,
  ISSUE_OF_ITEM,
  ITEMS_OF_ISSUE,
  LINKED_BRANCHES,
  PARENT,
  REVIEW_THREADS,
} from './queries.js'
import { type OpenPr, openPr, type RawItem, type RawPr } from './shapes.js'
import { closingRefs } from './stack.js'
import type { RawComment, RawReview, RawThread } from './timeline.js'

export interface BoardRef {
  owner: string
  number: number
}

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
  checks?: Array<{ id?: number; name?: string; status: string; conclusion: string | null }>
  statuses?: Array<{ state: string }>
  /** Los workflow runs de Actions del commit: uno en cola todavía no tiene check-runs. */
  workflowRuns?: Array<{ status: string }>
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

  /** Los issues que el PR cierra (su sección "Development"), en el orden que GitHub los da. Un PR
   *  abierto que no apunta a la default branch (uno apilado) no tiene esa sección —GitHub ignora
   *  sus palabras clave—: sus issues salen del `Closes #n` de su body. Uno ya mergeado en otra rama
   *  no cerró nada: su código no está en la default, y su issue sigue abierto. */
  async closingIssues(
    owner: string,
    repo: string,
    number: number,
  ): Promise<Array<{ owner: string; repo: string; number: number }>> {
    const data = await this.client.graphql<{
      repository?: {
        defaultBranchRef?: { name: string } | null
        pullRequest?: {
          body?: string | null
          baseRefName?: string
          merged?: boolean
          closingIssuesReferences?: {
            nodes?: Array<{
              number: number
              repository: { name: string; owner: { login: string } }
            }>
          }
        } | null
      } | null
    }>(CLOSING_ISSUES, { owner, repo, number })
    const pr = data.repository?.pullRequest
    const linked = (pr?.closingIssuesReferences?.nodes ?? []).map((node) => ({
      owner: node.repository.owner.login,
      repo: node.repository.name,
      number: node.number,
    }))
    const base = pr?.baseRefName
    const stacked = base !== undefined && base !== data.repository?.defaultBranchRef?.name
    if (linked.length > 0 || !stacked || pr?.merged) return linked
    return closingRefs(pr?.body ?? '', { owner, repo })
  }

  /** El issue padre de `owner/repo#number` (del que es sub-issue), si tiene uno. Puede ser de otro
   *  repo. */
  async parentOf(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{ owner: string; repo: string; number: number } | undefined> {
    const data = await this.client.graphql<{
      repository?: {
        issue?: {
          parent?: { number: number; repository: { name: string; owner: { login: string } } } | null
        } | null
      } | null
    }>(PARENT, { owner, repo, number })
    const parent = data.repository?.issue?.parent
    if (!parent) return undefined
    return {
      owner: parent.repository.owner.login,
      repo: parent.repository.name,
      number: parent.number,
    }
  }

  /** El PR abierto que cierra el issue (vinculado a mano o con `Closes #n`), si hay uno; si no, el
   *  abierto desde una rama vinculada al issue: el de un PR apilado, que GitHub no vincula. */
  private async linkedOpenPr(owner: string, repo: string, number: number) {
    const data = await this.client.graphql<{
      repository?: {
        issue?: {
          closedByPullRequestsReferences?: { nodes?: Array<{ number: number; state: string }> }
          linkedBranches?: {
            nodes?: Array<{
              ref?: { associatedPullRequests?: { nodes?: Array<{ number: number }> } } | null
            }>
          }
        } | null
      } | null
    }>(CLOSING_PRS, { owner, repo, number })
    const issue = data.repository?.issue
    const closing = (issue?.closedByPullRequestsReferences?.nodes ?? []).find(
      (node) => node.state === 'OPEN',
    )
    if (closing) return closing.number
    return (issue?.linkedBranches?.nodes ?? []).flatMap(
      (node) => node.ref?.associatedPullRequests?.nodes ?? [],
    )[0]?.number
  }

  pull(
    owner: string,
    repo: string,
    number: number,
  ): Promise<RawPr & { body?: string | null; head: { ref: string; sha: string } }> {
    return this.client.requestJson(`/repos/${owner}/${repo}/pulls/${number}`)
  }

  /**
   * Las ramas de la task según su sección "Development": primero las de los PRs abiertos del mismo
   * repo que lo cierran, el más viejo primero (el que tiene el historial y el review), y después las
   * vinculadas al issue. Sin las de los PRs, una rama que subió el agente sin vincular no se
   * encontraba, y la task terminaba con otra rama y otro PR.
   */
  async linkedBranches(owner: string, repo: string, number: number): Promise<string[]> {
    const data = await this.client.graphql<{
      repository?: {
        issue?: {
          linkedBranches?: { nodes?: Array<{ ref?: { name: string } | null }> }
          closedByPullRequestsReferences?: {
            nodes?: Array<{
              state?: string
              headRefName?: string
              isCrossRepository?: boolean
              createdAt?: string
              repository?: { nameWithOwner?: string }
            } | null>
          }
        } | null
      } | null
    }>(LINKED_BRANCHES, { owner, repo, number })
    const issue = data.repository?.issue
    const linked = (issue?.linkedBranches?.nodes ?? []).map((node) => node.ref?.name)
    const fromPrs = (issue?.closedByPullRequestsReferences?.nodes ?? [])
      // Abierto, del repo del issue y con la rama en ese repo: un PR mergeado, de otro repo
      // (`Closes o/r#n`) o de un fork no da una rama que la task pueda usar.
      .filter(
        (pr) =>
          pr &&
          (pr.state ?? 'OPEN') === 'OPEN' &&
          !pr.isCrossRepository &&
          sameRepo(pr.repository, owner, repo),
      )
      .sort((a, b) => (a?.createdAt ?? '').localeCompare(b?.createdAt ?? ''))
      .map((pr) => pr?.headRefName)
    // El PR primero: es donde están los commits y el review. Una rama vinculada sin PR puede ser
    // una que `link_branch` creó vacía en una reentrada anterior; si ganaba, la task cambiaba de
    // rama, `ensure_pull_request` no encontraba commits y la card quedaba blocked
    // (subscriptions#1775: tres nombres de rama en una task con el PR #1778 abierto).
    return [...new Set([...fromPrs, ...linked].filter((name): name is string => Boolean(name)))]
  }

  /**
   * Cuándo se le puso `label` al issue por última vez (`labeled` en sus eventos), o `undefined` si
   * nunca. Los eventos vienen del más viejo al más nuevo y de a 100: se recorren hasta 10 páginas.
   */
  async labeledAt(
    owner: string,
    repo: string,
    number: number,
    label: string,
  ): Promise<string | undefined> {
    let last: string | undefined
    for (let page = 1; page <= 10; page++) {
      const events = await this.client.requestJson<
        Array<{ event: string; created_at: string; label?: { name?: string } }>
      >(`/repos/${owner}/${repo}/issues/${number}/events?per_page=100&page=${page}`)
      for (const event of events) {
        if (event.event === 'labeled' && event.label?.name === label) last = event.created_at
      }
      if (events.length < 100) break
    }
    return last
  }

  /** Los sub-issues de `owner/repo#number` (su épica), abiertos o no; pueden ser de otro repo.
   *  Los primeros 100: una épica con más no es el caso. */
  subIssues(owner: string, repo: string, number: number) {
    return this.client.requestJson<
      Array<{ number: number; state: string; repository_url: string }>
    >(`/repos/${owner}/${repo}/issues/${number}/sub_issues?per_page=100`)
  }

  /** El número del PR abierto que cierra el issue, si hay uno. */
  openPullOf(owner: string, repo: string, number: number): Promise<number | undefined> {
    return this.linkedOpenPr(owner, repo, number)
  }

  /** Si GitHub puede mergear el PR contra su base (`base`): `mergeable: false` con `state: 'dirty'`
   *  es un conflicto; `mergeable: null` es que todavía lo está calculando (el primer GET después de
   *  un push o de un merge en la base lo dispara). */
  async mergeability(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{ mergeable: boolean | null; state?: string; base?: string }> {
    const pr = await this.client.requestJson<{
      mergeable?: boolean | null
      mergeable_state?: string
      base?: { ref?: string }
    }>(`/repos/${owner}/${repo}/pulls/${number}`)
    return {
      mergeable: pr.mergeable ?? null,
      ...(pr.mergeable_state ? { state: pr.mergeable_state } : {}),
      ...(pr.base?.ref ? { base: pr.base.ref } : {}),
    }
  }

  /** Los issues que `owner/repo#number` bloquea (`mark_blocked_by`). */
  dependents(owner: string, repo: string, number: number) {
    return this.client.requestJson<
      Array<{ number: number; state: string; repository_url: string }>
    >(`/repos/${owner}/${repo}/issues/${number}/dependencies/blocking`)
  }

  /** El issue, sus blockers y su timeline; con PR abierto (el del evento, o el que GitHub dice que
   *  cierra el issue), el timeline del PR y su CI.
   *
   *  Con `pullRequestOnly`, la task ES el PR (`number` = `pr`, un PR sin issue): por REST un PR
   *  también es un issue —título, body, labels—, pero no tiene blockers, y sus comentarios ya
   *  vienen como los del PR. */
  async context(task: {
    owner: string
    repo: string
    number: number
    pr?: number
    pullRequestOnly?: boolean
  }): Promise<RawTaskContext> {
    const base = `/repos/${task.owner}/${task.repo}`
    const only = task.pullRequestOnly === true
    const [issue, blockers, issueComments, pr] = await Promise.all([
      this.client.requestJson<RawTaskContext['issue']>(`${base}/issues/${task.number}`),
      only
        ? []
        : this.client.requestJson<RawTaskContext['blockers']>(
            `${base}/issues/${task.number}/dependencies/blocked_by`,
          ),
      only
        ? []
        : this.client.requestJson<RawComment[]>(
            `${base}/issues/${task.number}/comments?per_page=100`,
          ),
      this.openPr(task),
    ])
    if (!pr) return { issue, blockers, issueComments }
    const [prComments, threads, reviews, checks, status, runs] = await Promise.all([
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
      // Best-effort: sin permiso de `actions` (o en un repo sin Actions) el rollup se queda con
      // los checks y statuses, como antes.
      this.client
        .requestJson<{ workflow_runs: NonNullable<RawTaskContext['workflowRuns']> }>(
          `${base}/actions/runs?head_sha=${pr.headSha}&per_page=100`,
        )
        .catch(() => ({ workflow_runs: [] })),
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
      workflowRuns: runs.workflow_runs,
    }
  }

  /** El PR abierto de la task (el de `pr`, o el que GitHub vincula al issue), si hay uno. */
  openPullRequest(task: {
    owner: string
    repo: string
    number: number
    pr?: number
  }): Promise<OpenPr | undefined> {
    return this.openPr(task)
  }

  /** Si `head` ya trae el commit `sha` (`sha` es su ancestro, o es el mismo). */
  async contains(owner: string, repo: string, sha: string, head: string): Promise<boolean> {
    const compare = await this.client.requestJson<{ status: string }>(
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(head)}`,
    )
    return compare.status === 'ahead' || compare.status === 'identical'
  }

  /** El PR del evento si sigue abierto; si no trae uno, el que GitHub vincula al issue. */
  private async openPr(task: { owner: string; repo: string; number: number; pr?: number }) {
    const number = task.pr ?? (await this.linkedOpenPr(task.owner, task.repo, task.number))
    if (number === undefined) return undefined
    return openPr(await this.pull(task.owner, task.repo, number))
  }
}
