// Diffing del scan — convierte "el issue ESTÁ en Ready" en "PASÓ a Ready".
//
// Es el ÚNICO evento que produce un ciclo de scan (ya no hay un `issue.scanned`
// sintético que se re-emite igual haya cambiado algo o no) — un hecho con
// identidad, que pasó una vez, en vez de una observación que hay que
// re-evaluar en cada ciclo.
//
// Es **por item** y no por batch porque así es como el dispatch entrega: el
// `start(dispatch)` de un manager llama con un item a la vez. Diffear por lote
// obligaría a un hook nuevo en `SourceDispatcher` para ganar una comparación
// que igual cuesta una lectura de una fila indexada.
import type { EngineEvent } from '@ia-flow/shared'
import { createEvent } from '@ia-flow/shared'

/** Cambió el status de un issue: dice que se movió, y de dónde. */
export const ISSUE_STATUS_CHANGED = 'issue.status_changed'

/** Un issue apareció por primera vez en el board. */
export const ISSUE_CREATED = 'issue.created'

export interface DiffItem {
  id: string
  status: string
  repos?: string[]
  projectId?: string
  /** Id del ciclo de scan que trajo este item — ver `IssueItem.scanTraceId`
   *  en @ia-flow/issue-sources. Viaja como `EngineEvent.traceId` para que el
   *  run que una regla dispare sobre este evento quede trazable. */
  scanTraceId?: string
}

export interface DiffInput {
  item: DiffItem
  /** El status con el que este item quedó en el scan anterior. `undefined` =
   *  nunca se lo vio. */
  before: string | undefined
  /**
   * Si el proyecto NUNCA fue escaneado.
   *
   * Importa: sin esto, el primer scan de un board de 200 issues emitiría 200
   * `issue.created` — ruido, y además reglas disparando sobre issues viejos
   * que nadie tocó. En el primer scan sólo se aprende el estado.
   */
  bootstrap: boolean
}

/**
 * El evento que corresponde a este item, o `null` si no cambió nada.
 *
 * `null` es el caso normal y por lejos el más frecuente: en cada tick, la
 * enorme mayoría del board sigue igual. Ése es todo el punto — hoy cada scan
 * reprocesa el board entero.
 */
export function diffStatus({ item, before, bootstrap }: DiffInput): EngineEvent | null {
  if (bootstrap) return null

  const scope = {
    ...(item.projectId ? { projectId: item.projectId } : {}),
    ...(item.repos ? { repos: item.repos } : {}),
    issueId: item.id,
  }

  if (before === undefined) {
    return createEvent({
      type: ISSUE_CREATED,
      source: 'engine',
      scope,
      traceId: item.scanTraceId,
      // El item se aplana Y viaja completo bajo `item`: una condición `when`
      // migrada de la vieja activación por status (`field: 'title'`, etc.)
      // sigue resolviendo al nivel de arriba del payload, igual que contra
      // `issue.scanned`.
      payload: { ...item, status: item.status, item },
    })
  }

  // Case-insensitive, mismo criterio que usaba `matchesStatus`: los boards de
  // GitHub no garantizan capitalización estable, y un cambio de mayúsculas no
  // es un movimiento.
  if (before.toLowerCase() === item.status.toLowerCase()) return null

  return createEvent({
    type: ISSUE_STATUS_CHANGED,
    source: 'engine',
    scope,
    traceId: item.scanTraceId,
    // `from`/`to` son los nombres que una regla condiciona. `status` también
    // viaja, con el valor NUEVO, para que una condición sobre `status` siga
    // significando lo mismo que antes.
    payload: { ...item, from: before, to: item.status, status: item.status, item },
  })
}
