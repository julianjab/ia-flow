/**
 * Las cards abiertas de un board (GitHub Project v2), con lo que la bandeja clasifica: status, tipo,
 * labels, cuándo cambió, qué la bloquea y el PR que la cierra. Con la identidad del runner y un
 * cache corto por board: la bandeja se pide seguido y cada webhook del board lo invalida.
 */
import { Condition, type ConditionRow } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import type { BoardCard, BoardMeta } from '@ia-flow/github-tools'
import { invalidateMemoized, memoize } from '@ia-flow/shared'

export interface BoardSpec {
  projectId: string
  board: { owner: string; number: number; ownerKind?: 'orgs' | 'users' }
  /** Qué cards son del proyecto (`project.yaml` → `when`): las demás no se muestran. */
  when?: ConditionRow[]
}

/** El `item` de una card, con la misma forma que el evento de la task que arma el intake
 *  (`intake/payload.ts`): lo que mira el `when` del proyecto. */
export function cardItem(card: BoardCard) {
  return {
    status: card.status,
    // Como el intake: `Task Type` en minúsculas; sin él, `technical`.
    type: (card.taskType ?? 'technical').toLowerCase(),
    repos: [card.ref.split('#')[0]?.split('/')[1] ?? ''],
    labels: card.labels,
    blocked: card.blockedBy.length > 0,
  }
}

/** Si la card es del proyecto: cumple su `when` (sin `when`, todas). */
export function inProject(spec: Pick<BoardSpec, 'when'>, card: BoardCard): boolean {
  const when = (spec.when ?? []).map((row) => new Condition(row))
  return Condition.evaluateAll(when, { item: cardItem(card) })
}

export type { BoardMeta }

/** La página de un Project v2, de una org (`orgs`, por defecto) o de una cuenta personal (`users`). */
export const projectUrl = (board: BoardSpec['board']) =>
  `https://github.com/${board.ownerKind ?? 'orgs'}/${board.owner}/projects/${board.number}`

interface MetaPage {
  repositoryOwner?: {
    projectV2?: {
      url: string
      views: { nodes: Array<{ number: number; layout: string }> }
      field?: { options?: Array<{ name: string }> } | null
    } | null
  } | null
}

// `repositoryOwner` resuelve tanto una org como una cuenta personal: `ProjectV2Owner` los une.
const metaQuery = `query($owner: String!, $number: Int!) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        url
        views(first: 20) { nodes { number layout } }
        field(name: "Status") { ... on ProjectV2SingleSelectField { options { name } } }
      }
    }
  }
}`

/** Los links y columnas de un Project, de su respuesta de GraphQL. */
export function toBoardMeta(data: MetaPage, board: BoardSpec['board']): BoardMeta {
  const project = data.repositoryOwner?.projectV2
  const url = project?.url ?? projectUrl(board)
  const view = project?.views.nodes.find((node) => node.layout === 'BOARD_LAYOUT')
  return {
    url,
    boardUrl: view ? `${url}/views/${view.number}` : url,
    statuses: project?.field?.options?.map((option) => option.name) ?? [],
  }
}

interface RawIssueRef {
  number: number
  state: string
  url?: string
  repository: { name: string; owner: { login: string } }
}

interface RawBoardItem {
  id: string
  updatedAt: string
  isArchived?: boolean
  fieldValues?: { nodes: Array<{ name?: string; field?: { name?: string } }> }
  content?: {
    number?: number
    title?: string
    url?: string
    state?: string
    repository?: { name: string; owner: { login: string } }
    labels?: { nodes: Array<{ name: string }> }
    closedByPullRequestsReferences?: { nodes: RawIssueRef[] }
    blockedBy?: { nodes: RawIssueRef[] }
  }
}

interface ItemsPage {
  repositoryOwner?: {
    projectV2?: {
      items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawBoardItem[] }
    } | null
  } | null
}

const ISSUE_REF = 'number state url repository { name owner { login } }'

const itemsQuery = (
  withBlockers: boolean,
) => `query($owner: String!, $number: Int!, $after: String) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
    projectV2(number: $number) {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id updatedAt isArchived
          fieldValues(first: 30) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
          content {
            ... on Issue {
              number title url state
              repository { name owner { login } }
              labels(first: 30) { nodes { name } }
              closedByPullRequestsReferences(first: 5, includeClosedPrs: false) { nodes { ${ISSUE_REF} } }
              ${withBlockers ? `blockedBy(first: 20) { nodes { ${ISSUE_REF} } }` : ''}
            }
          }
        }
      }
    }
    }
  }
}`

/** Tope de páginas por board: 1000 cards. */
const MAX_PAGES = 10

const refOf = (issue: RawIssueRef): string =>
  `${issue.repository.owner.login}/${issue.repository.name}#${issue.number}`

/** Una card del board, si es un issue abierto. */
export function toBoardCard(item: RawBoardItem, spec: BoardSpec): BoardCard | undefined {
  const issue = item.content
  if (item.isArchived || !issue?.repository || issue.number === undefined) return undefined
  if (issue.state !== 'OPEN') return undefined
  const labels = (issue.labels?.nodes ?? []).map((label) => label.name)
  const field = (name: string) =>
    item.fieldValues?.nodes.find((value) => value.field?.name === name)?.name
  const pr = issue.closedByPullRequestsReferences?.nodes.find((ref) => ref.state === 'OPEN')
  const status = field('Status')
  const taskType = field('Task Type')
  return {
    ref: `${issue.repository.owner.login}/${issue.repository.name}#${issue.number}`,
    itemId: item.id,
    projectId: spec.projectId,
    title: issue.title ?? '',
    url: issue.url ?? '',
    ...(status ? { status } : {}),
    ...(taskType ? { taskType } : {}),
    labels,
    updatedAt: item.updatedAt,
    blockedBy: (issue.blockedBy?.nodes ?? [])
      .filter((blocker) => blocker.state === 'OPEN')
      .map(refOf),
    ...(pr ? { pr: { number: pr.number, url: pr.url ?? '' } } : {}),
  }
}

export class BoardReader {
  /** GitHub todavía no expone `blockedBy` en todos lados: si la query lo rechaza, sin él. */
  private withBlockers = true

  constructor(private readonly client: GithubClient) {}

  /** Las cards de un board, cacheadas un minuto; `refresh` (o un webhook) relee. */
  @memoize({
    ttlMs: 60_000,
    key: (spec: BoardSpec) => `${spec.board.owner}/${spec.board.number}`,
  })
  cards(spec: BoardSpec): Promise<BoardCard[]> {
    return this.read(spec)
  }

  /** Los links y columnas del Project: casi no cambian, se releen cada diez minutos. Si GitHub no
   *  responde, los links que se pueden armar sin preguntar y columnas sin orden. */
  @memoize({
    ttlMs: 10 * 60_000,
    key: (spec: BoardSpec) => `${spec.board.owner}/${spec.board.number}`,
  })
  meta(spec: BoardSpec): Promise<BoardMeta> {
    const { owner, number } = spec.board
    return this.client
      .graphql<MetaPage>(metaQuery, { owner, number })
      .then((data) => toBoardMeta(data, spec.board))
      .catch(() => toBoardMeta({}, spec.board))
  }

  /** Lo próximo que se pida, se relee (un webhook de ese board, una acción desde la bandeja). */
  invalidate(): void {
    invalidateMemoized(this, 'cards')
  }

  private async read(spec: BoardSpec): Promise<BoardCard[]> {
    const cards: BoardCard[] = []
    let after: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await this.page(spec, after)
      const items = data.repositoryOwner?.projectV2?.items
      if (!items) {
        throw new Error(`board ${spec.board.owner}#${spec.board.number}: no existe o no hay acceso`)
      }
      for (const item of items.nodes) {
        const card = toBoardCard(item, spec)
        if (card) cards.push(card)
      }
      if (!items.pageInfo.hasNextPage) break
      after = items.pageInfo.endCursor
    }
    return cards
  }

  private async page(spec: BoardSpec, after: string | null): Promise<ItemsPage> {
    const variables = { owner: spec.board.owner, number: spec.board.number, after }
    try {
      return await this.client.graphql<ItemsPage>(itemsQuery(this.withBlockers), variables)
    } catch (err) {
      if (!this.withBlockers || !/blockedBy/.test((err as Error).message)) throw err
      this.withBlockers = false
      return this.client.graphql<ItemsPage>(itemsQuery(false), variables)
    }
  }
}
