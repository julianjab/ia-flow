// Los eventos que produce el scan de una fuente.
//
// Vive acá y no en `agent-engine` porque su productor es `issue-sources` y su
// consumidor es el matcher de reglas — `agent-engine` ya no está en el medio
// desde que la activación se absorbió en `rules` (migración 059).
import type { EngineEvent } from '@ia-flow/shared'
import { ISSUE_SCANNED, createEvent } from '@ia-flow/shared'

/** La forma mínima que este módulo necesita de un item de la fuente. No importa
 *  `IssueItem` de `issue-sources` para no crear la arista rules → issue-sources:
 *  el paquete se mantiene sin dependencias más allá de `shared`. */
export interface ScannedItem {
  id: string
  status: string
  repos: string[]
  projectId?: string
}

/**
 * `IssueItem` → evento.
 *
 * El item entero viaja en `payload.item` y también aplanado en el payload: las
 * condiciones `when` de una regla evalúan contra `payload`, así que los campos
 * del issue quedan accesibles tanto como `payload.status` como bajo `item`.
 *
 * El `id` se sintetiza con sufijo aleatorio (default de `createEvent`) y no se
 * deriva del item: dos scans del mismo issue son dos hechos distintos y los dos
 * tienen que despachar. Deduplicarlos por id dejaría al issue sin reintento.
 */
export function issueScannedEvent(item: ScannedItem): EngineEvent {
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
