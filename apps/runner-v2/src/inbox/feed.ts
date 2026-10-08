/**
 * Con qué alimentar al pipeline: cuánto tiene corriendo el runner (`pipeline`) y qué cards de Todo
 * pueden arrancar ya o esperan a otra (`feed`). Puro: la ocupación entra ya medida.
 */
import type { InboxFeed, InboxFeedItem, InboxPipeline, RunnerCapacity } from '@ia-flow/shared'
import type { BoardCard } from './classify.js'

/** La ocupación tal como la lee la bandeja. `paused` no ocupa lugar: `free` sale de `running`. */
export function pipelineOf(capacity: RunnerCapacity): InboxPipeline {
  return {
    running: capacity.running,
    queued: capacity.waiting,
    paused: capacity.paused,
    ...(capacity.max_concurrent !== undefined
      ? {
          capacity: capacity.max_concurrent,
          free: capacity.free ?? Math.max(0, capacity.max_concurrent - capacity.running),
        }
      : {}),
  }
}

const feedItem = (card: BoardCard): InboxFeedItem => ({
  ref: card.ref,
  project_id: card.projectId,
  title: card.title,
  url: card.url,
  ...(card.status ? { status: card.status } : {}),
  labels: card.labels,
  updated_at: card.updatedAt,
  ...(card.pr ? { pr: card.pr } : {}),
  ...(card.blockedBy.length > 0 ? { blocked_by: card.blockedBy } : {}),
})

/**
 * Las cards en `todo` que todavía no arrancaron (sin corrida viva ni en cola), en el orden del
 * board: sin bloqueos, `ready`; con bloqueos, `waiting` con quién las bloquea.
 */
export function feedOf(
  cards: BoardCard[],
  todo: string,
  started: (ref: string) => boolean,
): InboxFeed {
  const feed: InboxFeed = { ready: [], waiting: [] }
  for (const card of cards) {
    if (card.status !== todo || started(card.ref)) continue
    ;(card.blockedBy.length > 0 ? feed.waiting : feed.ready).push(feedItem(card))
  }
  return feed
}
