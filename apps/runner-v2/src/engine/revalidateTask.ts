/**
 * Los hechos de AHORA para el evento de una task que esperó su turno (`EngineOptions.revalidate`):
 * la card como está en el board —su columna, sus labels, si está bloqueada, su tipo— en vez de
 * como estaba cuando llegó el evento. Con esto el engine vuelve a pasar el `when` de la pipeline
 * antes de correrla, y no corre un e2e "con la card en Review" que el review ya devolvió a Build.
 *
 * Sólo toca `item.*` (lo que filtran los `when` de las pipelines); el resto del payload es lo que
 * trajo el evento. Una task que ya no está en el board (su issue se cerró) o un evento que no es de
 * una task devuelven `undefined`: el engine sigue con el original, como antes.
 */
import type { DomainEvent } from '@ia-flow/agent-engine'
import type { BoardCard } from '@ia-flow/github-tools'
import type { Boards } from '../board/Boards.js'

type Payload = Record<string, unknown>

/** El evento con la card de ahora en `item.*` (y en `event.payload`, que los briefs leen). */
export function withCard(event: DomainEvent<any>, card: BoardCard): DomainEvent<any> {
  // El espejo `event.payload` se arma de nuevo: el viejo tiene la card de antes.
  const { event: _mirror, ...payload } = (event.payload ?? {}) as Payload
  const item: Payload = {
    ...(payload.item as Payload | undefined),
    status: card.status,
    labels: card.labels,
    blocked: card.blockedBy.length > 0,
    ...(card.taskType !== undefined ? { type: card.taskType } : {}),
  }
  const fresh: Payload = {
    ...payload,
    item,
    ...(card.taskType !== undefined ? { task_type: card.taskType } : {}),
  }
  return { ...event, payload: { ...fresh, event: { payload: { ...fresh } } } }
}

export function revalidateTask(
  boards: Pick<Boards, 'of'>,
): (event: DomainEvent<any>) => Promise<DomainEvent<any> | undefined> {
  return async (event) => {
    const { projectId, issue } = (event.scope ?? {}) as { projectId?: unknown; issue?: unknown }
    const payload = event.payload as Payload | undefined
    if (typeof projectId !== 'string' || typeof issue !== 'string' || !payload?.item) {
      return undefined
    }
    const board = boards.of(projectId)
    // La ejecución que la tuvo ocupada pudo mover la card hace segundos: nada de cache.
    board.invalidate()
    const card = (await board.cards()).find((candidate) => candidate.ref === issue)
    return card ? withCard(event, card) : undefined
  }
}
