/**
 * Las cards abiertas de un board (GitHub Project v2), con lo que la bandeja clasifica: status, tipo,
 * labels, cuándo cambió, qué la bloquea y el PR que la cierra. Con la identidad del runner y un
 * cache corto por board: la bandeja se pide seguido y cada webhook del board lo invalida.
 */
import type { GithubClient } from '@ia-flow/github-api'
import { invalidateMemoized, memoize } from '@ia-flow/shared'
import type { BoardCard } from './classify.js'

export interface BoardSpec {
  projectId: string
  board: { owner: string; number: number }
  /** Sólo las cards con esta label (`project.yaml` → `label`). */
  label?: string
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
  organization?: {
    projectV2?: {
      items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawBoardItem[] }
    } | null
  } | null
}

const ISSUE_REF = 'number state url repository { name owner { login } }'

const itemsQuery = (
  withBlockers: boolean,
) => `query($owner: String!, $number: Int!, $after: String) {
  organization(login: $owner) {
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
}`

/** Tope de páginas por board: 1000 cards. */
const MAX_PAGES = 10

const refOf = (issue: RawIssueRef): string =>
  `${issue.repository.owner.login}/${issue.repository.name}#${issue.number}`

/** Una card del board, si es un issue abierto (y del runner, si el proyecto tiene label). */
export function toBoardCard(item: RawBoardItem, spec: BoardSpec): BoardCard | undefined {
  const issue = item.content
  if (item.isArchived || !issue?.repository || issue.number === undefined) return undefined
  if (issue.state !== 'OPEN') return undefined
  const labels = (issue.labels?.nodes ?? []).map((label) => label.name)
  if (spec.label && !labels.includes(spec.label)) return undefined
  const field = (name: string) =>
    item.fieldValues?.nodes.find((value) => value.field?.name === name)?.name
  const pr = issue.closedByPullRequestsReferences?.nodes.find((ref) => ref.state === 'OPEN')
  const status = field('Status')
  const taskType = field('Task Type')
  return {
    ref: `${issue.repository.owner.login}/${issue.repository.name}#${issue.number}`,
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
    key: (spec: BoardSpec) => `${spec.board.owner}/${spec.board.number}/${spec.label ?? ''}`,
  })
  cards(spec: BoardSpec): Promise<BoardCard[]> {
    return this.read(spec)
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
      const items = data.organization?.projectV2?.items
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
