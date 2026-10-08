// Lo que manda el runner con `GET /api/inbox` —`feed` (Todo: listas y esperando) y `pipeline` (sus
// ejecuciones)— traducido a lo que dibuja la cola cuando el dashboard no define esos paneles. Y lo
// que espera a otra tarea (`kind: dep`), que no es «en cola». Puro, sin Vue.

import type { InboxFeed, InboxItem, InboxPipeline, RunnerCapacity } from '@ia-flow/shared'
import { refUrl, shortRef } from '@/features/inbox/queue/shortRef'
import type { DashboardView } from '@/features/inbox/view/decide'

/** El título del feed cuando lo pone el runner (el mismo default que el del dashboard). */
export const RUNNER_FEED_TITLE = 'Qué le das al pipeline'

/** La tarea que frena a otra: «espera subs#1579 ↗». */
export interface Blocker {
  short: string
  /** Sin forma `owner/repo#n`, sin link. */
  url?: string
}

export function blockerOf(ref: string): Blocker {
  const url = refUrl(ref)
  return { short: shortRef(ref), ...(url ? { url } : {}) }
}

/** Una línea del feed, con o sin acción; la que espera a otra trae a quién. */
export interface RunnerFeedEntry {
  ref: string
  title: string
  url: string
  action?: { id: string; label: string }
  waitingOn?: Blocker
}

/** El feed del runner como el del dashboard: primero las listas, después las que esperan. */
export function runnerFeed(feed: InboxFeed | undefined | null): {
  title: string
  entries: RunnerFeedEntry[]
} | null {
  if (!feed) return null
  const line = (card: InboxFeed['ready'][number]) => ({
    ref: card.ref,
    title: card.title,
    url: card.url,
  })
  return {
    title: RUNNER_FEED_TITLE,
    entries: [
      ...feed.ready.map(line),
      ...feed.waiting.map((card) => {
        const first = card.blocked_by?.[0]
        return { ...line(card), ...(first ? { waitingOn: blockerOf(first) } : {}) }
      }),
    ],
  }
}

/** El feed que se dibuja: el del dashboard si lo define; si no, el del runner. */
export function pickFeed(
  dashboard: DashboardView['feed'] | undefined,
  runner: InboxFeed | undefined | null,
): { title: string; entries: RunnerFeedEntry[] } | null {
  return dashboard ?? runnerFeed(runner)
}

/** La ocupación del runner (`/api/inbox`) con la forma de la de `/api/tasks`. */
export function capacityOf(pipeline: InboxPipeline | undefined | null): RunnerCapacity | null {
  if (!pipeline) return null
  return {
    running: pipeline.running,
    waiting: pipeline.queued,
    paused: pipeline.paused,
    ...(pipeline.capacity !== undefined ? { max_concurrent: pipeline.capacity } : {}),
    ...(pipeline.free !== undefined ? { free: pipeline.free } : {}),
  }
}

/** Espera a otra tarea (bloqueada por un issue abierto): no es una ejecución esperando turno. */
export const isBlockedWait = (item: Pick<InboxItem, 'group' | 'kind'>) =>
  item.group === 'queue' && item.kind === 'dep'

/** Espera su turno de ejecución: lo que cuenta y lista «en cola». */
export const isQueuedRun = (item: Pick<InboxItem, 'group' | 'kind'>) =>
  item.group === 'queue' && item.kind !== 'dep'

export interface BlockedEntry {
  ref: string
  short: string
  url: string
  title: string
  /** Lo que la frena (el primer bloqueante); sin dato, ausente. */
  waitingOn?: Blocker
}

/** Las que esperan a otra tarea: la línea «N esperan a otra tarea». */
export function blockedOf(items: readonly InboxItem[]): BlockedEntry[] {
  return items.filter(isBlockedWait).map((item) => {
    const first = item.blocked_by?.[0]
    return {
      ref: item.ref,
      short: shortRef(item.ref),
      url: item.url,
      title: item.title,
      ...(first ? { waitingOn: blockerOf(first) } : {}),
    }
  })
}
