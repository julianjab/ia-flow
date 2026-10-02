/**
 * Los hechos de una tarea, sin clasificar (`TaskFacts` de `@ia-flow/shared`): la raíz sobre la que
 * se evalúa un `when` —el `available` de una acción del runner, o una decisión de un dashboard— y se
 * resuelve una plantilla. Puro.
 */
import type { ExecutionSummary, TaskFacts } from '@ia-flow/shared'
import { cardItem } from './BoardReader.js'
import type { BoardCard, TaskActivity } from './classify.js'

const HOUR_MS = 3_600_000

const defined = (entries: Array<[string, string | undefined]>): Record<string, string> =>
  Object.fromEntries(entries.filter((entry): entry is [string, string] => !!entry[1]))

/** `run.*`: lo que dijo la última ejecución cerrada de la task; sin ella, vacío. */
export function runFacts(lastClosed: ExecutionSummary | undefined): Record<string, string> {
  if (!lastClosed) return {}
  return defined([
    ['exit', lastClosed.exit],
    ['status', lastClosed.status],
    ['failure_by', lastClosed.failure?.by],
    ['agent', lastClosed.agent_id],
    ['summary', lastClosed.summary ?? lastClosed.failure?.message],
  ])
}

/** `live.*`: la corrida viva (corriendo o pausada); sin ella, vacío. `ci` sólo si espera el CI. */
export function liveFacts(live: ExecutionSummary | undefined): Record<string, string> {
  if (!live) return {}
  return defined([
    ['status', live.status],
    ['agent', live.agent_id],
    ['pause_id', live.pause?.pause_id],
    ['expires_at', live.pause?.expires_at],
    ['ci', live.pause && /ci/i.test(live.pause.pause_id) ? 'true' : undefined],
  ])
}

/** Cuántas tareas destraba cada issue: las que lo tienen entre sus bloqueadores. */
export function unlocksOf(cards: BoardCard[]): Map<string, number> {
  const unlocks = new Map<string, number>()
  for (const card of cards) {
    for (const blocker of card.blockedBy) unlocks.set(blocker, (unlocks.get(blocker) ?? 0) + 1)
  }
  return unlocks
}

const latest = (...dates: Array<string | undefined>): string =>
  dates
    .filter((date): date is string => date !== undefined)
    .sort()
    .at(-1) ?? ''

const hoursSince = (iso: string, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / HOUR_MS))

export function buildTaskFacts(
  card: BoardCard,
  activity: TaskActivity,
  context: { unlocks: number; now: Date },
): TaskFacts {
  const { live, lastClosed } = activity
  const idleSince = latest(
    card.updatedAt,
    activity.lastEventAt,
    lastClosed?.closed_at,
    live?.started_at,
  )
  return {
    item: cardItem(card),
    run: runFacts(lastClosed),
    live: liveFacts(live),
    queue: { waiting: activity.waiting },
    task: {
      idle_hours: hoursSince(idleSince, context.now),
      waiting_hours: hoursSince(lastClosed?.closed_at ?? card.updatedAt, context.now),
      unlocks: context.unlocks,
      blocked_by: card.blockedBy.length,
    },
    ...(card.pr ? { pr: { number: card.pr.number, url: card.pr.url } } : {}),
  }
}
