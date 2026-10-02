import type { GithubClient } from '@ia-flow/github-api'
import type {
  BoardCard,
  BoardMeta,
  BoardWriter,
  Card,
  IntakeBoard,
  IssueRef,
  ItemLookup,
} from '@ia-flow/github-tools'
import { locate } from '@ia-flow/github-webhook'
import { invalidateMemoized, memoize } from '@ia-flow/shared'
import { createLogger } from '@ia-flow/telemetry'
import type { Board, BoardRef, EventLocator, RawDelivery } from './Board.js'
import { IssueLabelFields } from './IssueLabelFields.js'
import {
  DEFAULT_STATUS_PREFIX,
  fieldPrefix,
  type LabelScheme,
  statusLabel,
  statusOfLabel,
  statusOfLabels,
  valueOfField,
} from './labelScheme.js'

export interface IssuesBoardOptions {
  /** Los repos del catálogo del proyecto: el board son sus issues abiertos. */
  repos: Array<{ owner: string; repo: string }>
  /** Las columnas, en orden. Sin ellas, cualquier `<prefijo>…` es una columna. */
  statuses?: string[]
  /** Prefijo de los labels de Status (`status:`). */
  statusPrefix?: string
  /** Los otros campos que el runner escribe como label (`Task Type`, la marca "en curso"): su
   *  cambio es un efecto del propio runner y no despierta a ninguna pipeline. */
  fields?: string[]
  /** El label que dice "trabada esperando a una persona" (`inbox.labels.blocked`): una card en la
   *  columna `Blocked` lo trae aunque el issue sólo tenga `status:blocked`. Default `blocked`. */
  blockedLabel?: string
}

interface RawRef {
  number: number
  state: string
  url?: string
  repository: { name: string; owner: { login: string } }
}

/** Un issue como lo devuelve la query de la bandeja. */
export interface RawIssueCard {
  number: number
  title: string
  url: string
  updatedAt: string
  labels?: { nodes: Array<{ name: string }> }
  closedByPullRequestsReferences?: { nodes: RawRef[] }
  blockedBy?: { nodes: RawRef[] }
}

interface IssuesPage {
  repository?: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: RawIssueCard[]
    }
  } | null
}

const REF = 'number state url repository { name owner { login } }'

const issuesQuery = (
  withBlockers: boolean,
) => `query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url updatedAt
        labels(first: 100) { nodes { name } }
        closedByPullRequestsReferences(first: 5, includeClosedPrs: false) { nodes { ${REF} } }
        ${withBlockers ? `blockedBy(first: 20) { nodes { ${REF} } }` : ''}
      }
    }
  }
}`

/** Tope de páginas por repo: 1000 issues abiertos. */
const MAX_PAGES = 10

const DEFAULT_BLOCKED_LABEL = 'blocked'

const refString = (issue: IssueRef) => `${issue.owner}/${issue.repo}#${issue.number}`
const sameRepo = (a: { owner: string; repo: string }, b: { owner: string; repo: string }) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()

/** Un issue abierto de un repo del catálogo, como card de la bandeja. */
export function toIssueCard(
  raw: RawIssueCard,
  repo: { owner: string; repo: string },
  projectId: string,
  scheme: LabelScheme,
  blockedLabel = DEFAULT_BLOCKED_LABEL,
): BoardCard {
  const own = (raw.labels?.nodes ?? []).map((label) => label.name)
  const status = statusOfLabels(own, scheme)
  // Un board de issues guarda la columna en un label: `status:blocked` ES "trabada". El label
  // `blocked` que ponen el `onError` y un Project v2 se deriva, así quien lee la card (la bandeja,
  // las guardas de una acción) no distingue de qué board viene.
  // `blocked` = el label `blocked` O la columna Blocked (`status:blocked`), esté o no entre las
  // columnas declaradas.
  const inBlockedColumn =
    status?.toLowerCase() === 'blocked' ||
    own.some((label) => label.toLowerCase() === `${scheme.prefix}blocked`.toLowerCase())
  const labels = inBlockedColumn && !own.includes(blockedLabel) ? [...own, blockedLabel] : own
  const taskType = valueOfField(labels, 'Task Type', scheme)
  const pr = raw.closedByPullRequestsReferences?.nodes.find((ref) => ref.state === 'OPEN')
  const ref = refString({ ...repo, number: raw.number })
  return {
    ref,
    // Un issue no tiene un item en un board: la card se identifica por su ref.
    itemId: ref,
    projectId,
    title: raw.title,
    url: raw.url,
    ...(status ? { status } : {}),
    ...(taskType ? { taskType } : {}),
    labels,
    updatedAt: raw.updatedAt,
    blockedBy: (raw.blockedBy?.nodes ?? [])
      .filter((blocker) => blocker.state === 'OPEN')
      .map(
        (blocker) =>
          `${blocker.repository.owner.login}/${blocker.repository.name}#${blocker.number}`,
      ),
    ...(pr ? { pr: { number: pr.number, url: pr.url ?? '' } } : {}),
  }
}

/**
 * El board de los issues de un repo: no hay Project, la card ES el issue y su estado vive en sus
 * labels (`status:build`, ver `labelScheme`). Todo lo que hace un Project v2 lo hace con lo que el
 * repo ya tiene:
 *
 *  - la bandeja lista los issues abiertos de los repos del catálogo;
 *  - un issue "está en el board" por existir: agregarlo no hace nada;
 *  - el cambio de columna llega por el webhook `issues` (un label `status:*` puesto), que `locate`
 *    traduce a `issue.status_changed`, el mismo evento que un Project v2 — así las pipelines no
 *    saben con cuál de los dos board corren.
 *
 * Como todo es del repo, sirve el token de instalación de una GitHub App; un Project v2 de una
 * cuenta personal no.
 */
export class IssuesBoard implements Board {
  readonly kind = 'issues' as const
  readonly ref: BoardRef
  readonly intake: IntakeBoard
  private readonly scheme: LabelScheme
  private readonly fields: IssueLabelFields
  private readonly repos: Array<{ owner: string; repo: string }>
  /** Los prefijos de los labels de los otros campos que escribe el runner (`task-type:`, `working:`). */
  private readonly fieldPrefixes: string[]
  private readonly blockedLabel: string
  private readonly log = createLogger('runner.issues-board')
  /** GitHub todavía no expone `blockedBy` en todos lados: si la query lo rechaza, sin él. */
  private withBlockers = true

  constructor(
    readonly projectId: string,
    private readonly client: GithubClient,
    options: IssuesBoardOptions,
  ) {
    const first = options.repos[0]
    if (!first) throw new Error(`proyecto ${projectId}: un board de issues necesita algún repo`)
    this.repos = options.repos
    this.ref = { owner: first.owner, number: 0 }
    this.scheme = {
      prefix: options.statusPrefix ?? DEFAULT_STATUS_PREFIX,
      statuses: options.statuses ?? [],
    }
    this.fields = new IssueLabelFields(client, this.scheme)
    this.blockedLabel = options.blockedLabel ?? DEFAULT_BLOCKED_LABEL
    this.fieldPrefixes = (options.fields ?? []).map((field) => fieldPrefix(field, this.scheme))
    this.intake = {
      cardOf: (issue) => this.cardOf(issue),
      issueOfItem: async (itemId) => this.issueOfItem(itemId),
    }
  }

  describe(): string {
    return `issues de ${this.repos.map((repo) => `${repo.owner}/${repo.repo}`).join(', ')}`
  }

  /** Las cards, cacheadas un minuto; un webhook o una acción desde la bandeja relee. */
  @memoize({ ttlMs: 60_000, key: () => 'cards' })
  cards(): Promise<BoardCard[]> {
    return this.readAll()
  }

  async meta(): Promise<BoardMeta> {
    const first = this.repos[0] as { owner: string; repo: string }
    const url = `https://github.com/${first.owner}/${first.repo}/issues`
    return { url, boardUrl: url, statuses: this.scheme.statuses }
  }

  invalidate(): void {
    invalidateMemoized(this, 'cards')
  }

  setFields(...args: Parameters<BoardWriter['setFields']>): Promise<void> {
    return this.fields.setFields(...args)
  }

  /** Un issue ya es parte del board: no hay nada que agregar. */
  async addIssue(): Promise<{ itemId?: string }> {
    return {}
  }

  writerFor(client: GithubClient): BoardWriter {
    return client === this.client ? this.fields : new IssueLabelFields(client, this.scheme)
  }

  /**
   * Los webhooks de siempre, con una diferencia: un label de Status puesto es un cambio de columna
   * (`issue.status_changed`, con la columna en `to`), y sacarlo no es nada (el nuevo llega por su
   * propio webhook). Cualquier otro label sigue siendo `issue.labeled`.
   */
  readonly locate: EventLocator = (type, raw) => {
    const location = locate(type, raw)
    if (type !== 'issues' || 'skip' in location) return location
    const label = typeof location.extra.label === 'string' ? location.extra.label : undefined
    const status = label ? statusOfLabel(label, this.scheme) : undefined
    if (label && !status && this.isFieldLabel(label)) {
      return { skip: `${label} es un campo que escribe el runner` }
    }
    if (!status) return location
    if (location.emit === 'issue.unlabeled') {
      return { skip: `Status sin cambio (se sacó ${label})` }
    }
    if (location.emit !== 'issue.labeled') return location
    const from = this.previousStatus(raw, status)
    return {
      ...location,
      emit: 'issue.status_changed',
      status,
      extra: { ...location.extra, ...(from ? { from } : {}), to: status },
    }
  }

  /** "La card llegó a `status`": el webhook de un label de Status puesto por `sender`. */
  statusChange(card: BoardCard, status: string, sender: string): RawDelivery {
    const [path, number] = card.ref.split('#') as [string, string]
    const [owner, repo] = path.split('/') as [string, string]
    return {
      event: 'issues',
      id: `rerun-${card.ref}-${Date.now()}`,
      payload: {
        action: 'labeled',
        label: { name: statusLabel(status, this.scheme) },
        issue: {
          number: Number(number),
          title: card.title,
          body: '',
          labels: card.labels.map((name) => ({ name })),
        },
        repository: { name: repo, owner: { login: owner } },
        sender: { login: sender },
      },
    }
  }

  /**
   * De qué columna venía la card: el runner agrega el label nuevo ANTES de sacar el viejo, así que
   * en el webhook del nuevo el viejo todavía está en los labels del issue. Si una persona cambió
   * la columna a mano (sacó uno y puso otro) el viejo ya no está, y `from` queda sin decir.
   */
  private previousStatus(raw: Record<string, unknown>, status: string): string | undefined {
    const issue = raw.issue as { labels?: Array<{ name?: string }> } | undefined
    const others = (issue?.labels ?? []).flatMap((label) => {
      const found = label.name ? statusOfLabel(label.name, this.scheme) : undefined
      return found && found.toLowerCase() !== status.toLowerCase() ? [found] : []
    })
    return others.length > 0
      ? statusOfLabels(
          others.map((name) => statusLabel(name, this.scheme)),
          this.scheme,
        )
      : undefined
  }

  private isFieldLabel(label: string): boolean {
    return this.fieldPrefixes.some((prefix) => label.toLowerCase().startsWith(prefix.toLowerCase()))
  }

  private inCatalog(issue: IssueRef): boolean {
    return this.repos.some((repo) => sameRepo(repo, issue))
  }

  private async cardOf(issue: IssueRef): Promise<Card | undefined> {
    if (!this.inCatalog(issue)) return undefined
    const { labels, isPullRequest } = await this.fields.read(issue)
    if (isPullRequest) return undefined
    const status = statusOfLabels(labels, this.scheme)
    const type = valueOfField(labels, 'Task Type', this.scheme) ?? 'technical'
    return {
      itemId: refString(issue),
      ...(status ? { status } : {}),
      type: type.toLowerCase(),
    }
  }

  private issueOfItem(itemId: string): ItemLookup {
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(itemId)
    if (!match) return { skipped: `"${itemId}" no es un issue de este board` }
    const issue = { owner: match[1] as string, repo: match[2] as string, number: Number(match[3]) }
    return this.inCatalog(issue)
      ? { issue }
      : { skipped: `${itemId} no es de los repos de ${this.projectId}` }
  }

  private async readAll(): Promise<BoardCard[]> {
    const cards: BoardCard[] = []
    for (const repo of this.repos) {
      let after: string | null = null
      for (let page = 0; page < MAX_PAGES; page++) {
        const data: IssuesPage = await this.page(repo, after)
        const issues = data.repository?.issues
        if (!issues) throw new Error(`repo ${repo.owner}/${repo.repo}: no existe o no hay acceso`)
        for (const raw of issues.nodes)
          cards.push(toIssueCard(raw, repo, this.projectId, this.scheme, this.blockedLabel))
        if (!issues.pageInfo.hasNextPage) break
        if (page === MAX_PAGES - 1) {
          this.log.warn(
            `${repo.owner}/${repo.repo}: más de ${MAX_PAGES * 100} issues abiertos, la bandeja muestra los más recientes`,
          )
        }
        after = issues.pageInfo.endCursor
      }
    }
    return cards
  }

  private async page(repo: { owner: string; repo: string }, after: string | null) {
    const variables = { owner: repo.owner, repo: repo.repo, after }
    try {
      return await this.client.graphql<IssuesPage>(issuesQuery(this.withBlockers), variables)
    } catch (err) {
      if (!this.withBlockers || !/blockedBy/.test((err as Error).message)) throw err
      this.withBlockers = false
      return this.client.graphql<IssuesPage>(issuesQuery(false), variables)
    }
  }
}
