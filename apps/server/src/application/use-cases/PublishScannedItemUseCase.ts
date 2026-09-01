import { type EventOutcome, diffStatus } from '@ia-flow/rules'
import type { IEventBus } from '../../domain/ports/IEventBus.js'
import type { IssueItem } from '../../domain/ports/IIssueManager.js'
import type { ISeenItemRepository } from '../../domain/ports/ISeenItemRepository.js'

export interface PublishScannedItemDeps {
  /** El fallo del diff se loguea y se sigue: es aditivo, y romper el scan por
   *  él sería cambiar una mejora por una regresión. */
  onDiffError(err: unknown, ctx: { itemId: string; projectId: string }): void
}

/**
 * Un item escaneado produce COMO MUCHO un evento: `issue.created` o
 * `issue.status_changed`, sólo cuando algo cambió desde el scan anterior. No
 * hay más `issue.scanned` sintético que se re-emite igual todos los ciclos —
 * la activación de agentes (migración 059) escucha estos dos.
 *
 * El item completo viaja en el evento (no una versión recortada): desde que
 * estos eventos alimentan la acción `agent` de una regla, tienen que traer
 * todo lo que un dispatch real necesita, no sólo lo que el diff compara.
 */
export class PublishScannedItemUseCase {
  constructor(
    private readonly seen: ISeenItemRepository,
    private readonly bus: IEventBus,
    private readonly deps: PublishScannedItemDeps,
  ) {}

  async execute(item: IssueItem): Promise<EventOutcome> {
    const projectId = item.projectId
    if (!projectId) return 'skipped'

    let changed: ReturnType<typeof diffStatus>
    try {
      changed = diffStatus({
        item,
        before: this.seen.get(projectId, item.id),
        // Sin esto, el primer scan de un board grande emitiría un
        // `issue.created` por issue — ruido, y reglas disparando sobre
        // issues viejos que nadie tocó.
        bootstrap: !this.seen.hasSeen(projectId),
      })
    } catch (err) {
      this.deps.onDiffError(err, { itemId: item.id, projectId })
      return 'skipped'
    }

    if (!changed) {
      // Nada cambió (o es bootstrap): igual se aprende el status para que el
      // próximo scan tenga con qué comparar. No hay nada que reintentar.
      this.seen.set(projectId, item.id, item.status)
      return 'skipped'
    }

    const outcome = await this.bus.publish(changed)
    // Sólo se aprende el status nuevo si NO quedó diferido por capacidad: un
    // `deferred` tiene que ver el MISMO diff la próxima vez que se reintente
    // este item, o el cambio se pierde sin que ningún agente lo haya corrido.
    if (outcome !== 'deferred') this.seen.set(projectId, item.id, item.status)
    return outcome
  }
}
