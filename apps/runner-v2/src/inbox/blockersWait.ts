import type { ActivityPort, ExplainPort } from './ActivityPort.js'
import type { BoardCard } from './classify.js'

/**
 * Si la columna de la card espera a sus blockers: lo que diría el engine si la card llegara AHORA a
 * su columna (un `issue.status_changed` armado sobre su último evento, como `explain`). Si alguna
 * pipeline de su proyecto correría, los blockers no la frenan —ej. un Refine que sólo espera
 * blockers en una épica— y la card no está "en cola por dependencia": nadie la tomó
 * (subscriptions#2041). Sin evento previo, o si `explain` falla, se asume que espera, como antes.
 */
export async function blockersWait(
  card: BoardCard,
  activity: Pick<ActivityPort, 'lastDispatchedEvent'>,
  explain: ExplainPort,
): Promise<boolean> {
  if (card.blockedBy.length === 0 || !card.status) return true
  const last = activity.lastDispatchedEvent(card.ref)
  if (!last) return true
  const payload = (
    typeof last.payload === 'object' && last.payload !== null ? last.payload : {}
  ) as Record<string, unknown>
  // La card como está ahora: su último evento pudo ser de cuando estaba en otra columna.
  const item = typeof payload.item === 'object' && payload.item !== null ? payload.item : {}
  try {
    const decisions = await explain({
      ...last,
      id: `blockers-${last.id}`,
      type: 'issue.status_changed',
      payload: { ...payload, to: card.status, item: { ...item, status: card.status } },
    })
    return !decisions.some(
      (decision) => decision.verdict === 'ran' && decision.source_id === card.projectId,
    )
  } catch {
    return true
  }
}
