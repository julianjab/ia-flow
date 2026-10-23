/**
 * Las cards cerradas de un board (GitHub Project v2): lo que ya terminó, para verlo sin salir de
 * ia-flow. La bandeja no las necesita —`BoardReader` lee sólo las abiertas—, así que se piden
 * cuando alguien abre «Cerrados» en el resto del board, con un cache de cinco minutos; las cerradas
 * más recientes primero, hasta `CLOSED_MAX`.
 */
import type { GithubClient } from '@ia-flow/github-api'
import { memoize } from '@ia-flow/shared'
import type { BoardSpec } from './BoardReader.js'

export interface ClosedCard {
  /** `owner/repo#n` */
  ref: string
  projectId: string
  title: string
  url: string
  status?: string
  labels: string[]
  /** Cuándo se cerró el issue (ISO). */
  closedAt: string
}

/** Cuántas cerradas se devuelven por board: las más recientes. */
export const CLOSED_MAX = 100
/** Un Project con historia tiene cientos de cerradas: tres páginas alcanzan para las recientes. */
const MAX_PAGES = 3

interface RawClosedItem {
  isArchived?: boolean
  fieldValues?: { nodes: Array<{ name?: string; field?: { name?: string } }> }
  content?: {
    number?: number
    title?: string
    url?: string
    state?: string
    closedAt?: string | null
    repository?: { name: string; owner: { login: string } }
    labels?: { nodes: Array<{ name: string }> }
  }
}

interface ClosedPage {
  repositoryOwner?: {
    projectV2?: {
      items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: RawClosedItem[]
      }
    } | null
  } | null
}

const closedQuery = `query($owner: String!, $number: Int!, $after: String) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
    projectV2(number: $number) {
      items(first: 100, after: $after, query: "is:closed") {
        pageInfo { hasNextPage endCursor }
        nodes {
          isArchived
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
              number title url state closedAt
              repository { name owner { login } }
              labels(first: 20) { nodes { name } }
            }
          }
        }
      }
    }
    }
  }
}`

/** Una card cerrada del board, si es un issue cerrado y no está archivada. */
export function toClosedCard(item: RawClosedItem, spec: BoardSpec): ClosedCard | undefined {
  const issue = item.content
  if (item.isArchived || !issue?.repository || issue.number === undefined) return undefined
  if (issue.state !== 'CLOSED') return undefined
  const status = item.fieldValues?.nodes.find((value) => value.field?.name === 'Status')?.name
  return {
    ref: `${issue.repository.owner.login}/${issue.repository.name}#${issue.number}`,
    projectId: spec.projectId,
    title: issue.title ?? '',
    url: issue.url ?? '',
    ...(status ? { status } : {}),
    labels: (issue.labels?.nodes ?? []).map((label) => label.name),
    closedAt: issue.closedAt ?? '',
  }
}

/** Las más recientes primero, hasta `CLOSED_MAX`. Puro. */
export function newestClosed(cards: readonly ClosedCard[]): ClosedCard[] {
  return [...cards].sort((a, b) => b.closedAt.localeCompare(a.closedAt)).slice(0, CLOSED_MAX)
}

export class ClosedCardsReader {
  constructor(private readonly client: GithubClient) {}

  @memoize({
    ttlMs: 5 * 60_000,
    key: (spec: BoardSpec) => `${spec.board.owner}/${spec.board.number}`,
  })
  closed(spec: BoardSpec): Promise<ClosedCard[]> {
    return this.read(spec)
  }

  private async read(spec: BoardSpec): Promise<ClosedCard[]> {
    const cards: ClosedCard[] = []
    let after: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: ClosedPage = await this.client.graphql<ClosedPage>(closedQuery, {
        owner: spec.board.owner,
        number: spec.board.number,
        after,
      })
      const items = data.repositoryOwner?.projectV2?.items
      if (!items) break
      for (const item of items.nodes) {
        const card = toClosedCard(item, spec)
        if (card) cards.push(card)
      }
      if (!items.pageInfo.hasNextPage) break
      after = items.pageInfo.endCursor
    }
    return newestClosed(cards)
  }
}
