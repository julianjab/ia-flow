// El handler que reproduce, sobre el bus, lo que antes era una llamada
// directa `SourceDispatcher → TaskDispatcher.dispatch`.
//
// Es **andamio con fecha de vencimiento**: existe para probar que meter el bus
// en el medio no cambió nada, y desaparece cuando la activación de los agentes
// se absorba en filas de `rules` y el handler genérico de acciones sea el que
// corra un agente. Mientras tanto es la única suscripción del bus, así que el
// engine se comporta exactamente igual que antes.
import type { DispatchOutcome, IIssueManager, IssueItem } from '@ia-flow/issue-sources'
import type { EventHandler, EventOutcome } from '@ia-flow/rules'
import type { EngineEvent } from '@ia-flow/shared'
import { ISSUE_SCANNED, createEvent } from '@ia-flow/shared'

/** Lo que `SourceDispatcher` sabe hacer con un item, inyectado para que este
 *  módulo no dependa de `TaskDispatcher` concreto. */
export type DispatchItem = (item: IssueItem, manager: IIssueManager) => Promise<DispatchOutcome>

/**
 * `IssueItem` → evento.
 *
 * El item entero viaja en `payload.item`: para este tipo de evento el payload
 * ES el item, y mantenerlo completo es lo que permite que el handler lo
 * reconstruya sin volver a pegarle a la fuente. Las condiciones `when` de una
 * regla evalúan contra `payload`, así que los campos del issue quedan
 * accesibles tanto planos (`payload.status`) como bajo `item`.
 *
 * El `id` se sintetiza con sufijo aleatorio (default de `createEvent`) y no se
 * deriva del item: dos scans del mismo issue son dos hechos distintos y los dos
 * tienen que despachar. Deduplicarlos por id dejaría al issue sin reintento.
 */
export function issueScannedEvent(item: IssueItem): EngineEvent {
  return createEvent({
    type: ISSUE_SCANNED,
    source: 'engine',
    scope: {
      projectId: item.projectId,
      repos: item.repos,
      issueId: item.id,
    },
    payload: { ...(item as unknown as Record<string, unknown>), item },
  })
}

/**
 * Un handler por manager, cerrando sobre el suyo.
 *
 * El filtro por `projectId` en `handles` es lo que hace que un delivery de un
 * proyecto no despierte a los managers de los otros — antes eso lo garantizaba
 * el cableado directo, ahora hay que declararlo.
 */
export function createIssueScannedHandler(
  manager: IIssueManager,
  projectId: string,
  dispatch: DispatchItem,
): EventHandler {
  return {
    id: `issue-scanned:${projectId}`,
    handles(event: EngineEvent): boolean {
      return event.type === ISSUE_SCANNED && event.scope.projectId === projectId
    },
    async handle(event: EngineEvent): Promise<EventOutcome> {
      const item = event.payload.item as IssueItem | undefined
      // Sin item no hay nada que despachar. `skipped` y no un throw: un evento
      // mal formado no debería reintentarse en loop.
      if (!item) return 'skipped'
      return await dispatch(item, manager)
    },
  }
}
