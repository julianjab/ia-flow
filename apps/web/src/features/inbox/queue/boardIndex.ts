// Qué está en el board y en qué columna, por ref en minúsculas: la bandeja, «Por arrancar» y el
// resto del board (`/api/board`). Un PR de una tarea apunta a su tarea, así un resultado que es el
// PR también se reconoce. Lo usa «Buscar en GitHub» para decir «En el board · Review» y abrir el
// detalle sin salir de la app. Puro.

import type { BoardRestItem, InboxItem } from '@ia-flow/shared'

/** Una tarea del board: su ref y su columna («» si no se sabe en cuál). */
export interface BoardEntry {
  ref: string
  status: string
}

interface Sources {
  items: readonly InboxItem[]
  /** «Por arrancar»: las cards de Todo. */
  feed: readonly BoardRestItem[]
  rest: readonly { status: string; items: readonly BoardRestItem[] }[]
}

type Card = Pick<InboxItem, 'ref' | 'status' | 'pr'>

/** `owner/repo#n` del PR de una card: del link del PR o, si no se lee, el repo de la card. */
function prRef(card: Card): string | null {
  if (!card.pr) return null
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/i.exec(card.pr.url)
  if (m) return `${m[1]}/${m[2]}#${card.pr.number}`
  const repo = /^([^#]+)#\d+$/.exec(card.ref)?.[1]
  return repo ? `${repo}#${card.pr.number}` : null
}

export function boardIndex({ items, feed, rest }: Sources): Map<string, BoardEntry> {
  const index = new Map<string, BoardEntry>()
  const put = (card: Card, status: string | undefined) => {
    const key = card.ref.toLowerCase()
    if (index.has(key)) return
    const entry = { ref: card.ref, status: status ?? '' }
    index.set(key, entry)
    const pr = prRef(card)?.toLowerCase()
    if (pr && !index.has(pr)) index.set(pr, entry)
  }
  for (const item of items) put(item, item.status)
  for (const item of feed) put(item, item.status ?? 'Todo')
  for (const column of rest) for (const item of column.items) put(item, column.status)
  return index
}
