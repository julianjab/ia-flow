/**
 * El board entero del contexto, por columna, para el asistente (`assistant_list_board`): las
 * columnas reales del Project —en su orden, con cuántas cards abiertas tiene cada una, aunque estén
 * vacías— y cada card, diga o no algo la bandeja (`in_inbox`). Lo arma a partir de lo que ya lee
 * `InboxService`: la bandeja (`inbox()`) y lo que la bandeja no muestra (`rest()`).
 */
import type { BoardRest, BoardRestItem, Inbox, InboxItem } from '@ia-flow/shared'

/** La columna de una card sin Status (la misma que usa `InboxService.rest`). */
export const NO_STATUS = 'Sin status'

export const BOARD_PAGE_LIMIT = 50
export const BOARD_PAGE_MAX_LIMIT = 200

const NOTE =
  'Sólo cards abiertas del board del proyecto. `in_inbox: false` = el board la tiene pero la bandeja no (no pide nada ahora).'
const NO_COLUMNS_NOTE =
  ' No se pudieron leer las columnas declaradas del board: `columns` sale sólo de las cards (sin las vacías ni el orden real).'

export interface BoardQuery {
  /** Una columna, tal como se llama en el board. */
  status?: string
  offset?: number
  limit?: number
}

export interface BoardColumn {
  status: string
  count: number
}

export interface BoardCardView {
  ref: string
  project: string
  title: string
  status: string
  labels: string[]
  in_inbox: boolean
  group?: InboxItem['group']
  kind?: InboxItem['kind']
  updated_at?: string
  pr?: number
  blocked_by?: string[]
}

export interface BoardView {
  columns: BoardColumn[]
  total: number
  cards: BoardCardView[]
  next_offset?: number
  note: string
}

function fromInbox(item: InboxItem): BoardCardView {
  return {
    ref: item.ref,
    project: item.project_id,
    title: item.title,
    status: item.status ?? NO_STATUS,
    labels: item.labels,
    in_inbox: true,
    group: item.group,
    kind: item.kind,
    ...(item.pr ? { pr: item.pr.number } : {}),
    ...(item.blocked_by?.length ? { blocked_by: item.blocked_by } : {}),
  }
}

function fromRest(item: BoardRestItem, status: string): BoardCardView {
  return {
    ref: item.ref,
    project: item.project_id,
    title: item.title,
    status,
    labels: item.labels,
    in_inbox: false,
    updated_at: item.updated_at,
    ...(item.pr ? { pr: item.pr.number } : {}),
  }
}

/** Las columnas declaradas por los boards, sin repetir y en su orden; después, las que sólo
 *  aparecen en las cards (como hace `rest()`: alfabéticas, al final). */
function columnOrder(inbox: Inbox, cards: BoardCardView[]): { order: string[]; declared: number } {
  const order: string[] = []
  for (const status of inbox.projects.flatMap((project) => project.statuses ?? [])) {
    if (!order.includes(status)) order.push(status)
  }
  const declared = order.length
  const extra = [...new Set(cards.map((card) => card.status))].filter((s) => !order.includes(s))
  return { order: [...order, ...extra.sort((a, b) => a.localeCompare(b))], declared }
}

/** Que `status` sea una columna del board; sin columnas declaradas (el `meta` falló), cualquiera. */
function assertColumn(status: string, order: string[], declared: number): void {
  if (declared > 0 && !order.includes(status)) {
    throw new Error(`"${status}" no es una columna del board: ${order.join(', ')}`)
  }
}

export function boardView(inbox: Inbox, rest: BoardRest, query: BoardQuery = {}): BoardView {
  // Primero las de la bandeja (en su orden de prioridad), después el resto (lo más reciente
  // primero, como ya viene de `rest`): al agrupar por columna, ese orden se conserva.
  const all = [
    ...inbox.items.map(fromInbox),
    ...rest.columns.flatMap((column) => column.items.map((item) => fromRest(item, column.status))),
  ]
  const { order, declared } = columnOrder(inbox, all)
  const status = query.status?.trim()
  if (status) assertColumn(status, order, declared)
  const shown = status ? [status] : order
  const cards = shown.flatMap((column) => all.filter((card) => card.status === column))
  const offset = Math.max(query.offset ?? 0, 0)
  const limit = Math.min(Math.max(query.limit ?? BOARD_PAGE_LIMIT, 1), BOARD_PAGE_MAX_LIMIT)
  const end = offset + limit
  return {
    columns: order.map((column) => ({
      status: column,
      count: all.filter((card) => card.status === column).length,
    })),
    total: cards.length,
    cards: cards.slice(offset, end),
    ...(end < cards.length ? { next_offset: end } : {}),
    note: declared > 0 ? NOTE : `${NOTE}${NO_COLUMNS_NOTE}`,
  }
}
