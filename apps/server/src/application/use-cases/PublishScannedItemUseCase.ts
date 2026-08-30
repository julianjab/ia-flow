import { type EventOutcome, diffStatus, issueScannedEvent } from '@ia-flow/rules'
import type { IEventBus } from '../../domain/ports/IEventBus.js'
import type { IssueItem } from '../../domain/ports/IIssueManager.js'
import type { ISeenItemRepository } from '../../domain/ports/ISeenItemRepository.js'

export interface PublishScannedItemDeps {
  /** El fallo del diff se loguea y se sigue: es aditivo, y romper el scan por
   *  él sería cambiar una mejora por una regresión. */
  onDiffError(err: unknown, ctx: { itemId: string; projectId: string }): void
}

/**
 * Un item escaneado produce DOS eventos, no uno.
 *
 * `issue.scanned` reproduce el comportamiento histórico —es sobre lo que
 * condiciona la regla que escribió la migración 059—, y el diff
 * (`issue.status_changed` / `issue.created`) es el que permite escribir reglas
 * nuevas sobre "pasó a", que es un hecho con identidad. Reemplazar uno por el
 * otro habría roto todo roster migrado, así que van los dos.
 *
 * **El outcome que vuelve es el de `issue.scanned`**: es el que
 * `SourceDispatcher` usa para decidir si el item vuelve al backlog, y el del
 * diff no representa capacidad.
 */
export class PublishScannedItemUseCase {
  constructor(
    private readonly seen: ISeenItemRepository,
    private readonly bus: IEventBus,
    private readonly deps: PublishScannedItemDeps,
  ) {}

  async execute(item: IssueItem): Promise<EventOutcome> {
    const projectId = item.projectId
    if (projectId) {
      try {
        const changed = diffStatus({
          item: { id: item.id, status: item.status, repos: item.repos, projectId },
          before: this.seen.get(projectId, item.id),
          // Sin esto, el primer scan de un board grande emitiría un
          // `issue.created` por issue — ruido, y reglas disparando sobre
          // issues viejos que nadie tocó.
          bootstrap: !this.seen.hasSeen(projectId),
        })
        // Se aprende el status ANTES de publicar: si el handler tira, el
        // próximo scan no debe volver a ver el mismo cambio como nuevo.
        this.seen.set(projectId, item.id, item.status)
        if (changed) await this.bus.publish(changed)
      } catch (err) {
        this.deps.onDiffError(err, { itemId: item.id, projectId })
      }
    }
    return this.bus.publish(issueScannedEvent(item))
  }
}
