// Diffing del scan — convierte "el issue ESTÁ en Ready" en "PASÓ a Ready".
//
// El scan es stateless respecto del anterior: no guarda el board previo, así
// que el único evento que puede producir es `issue.scanned`. Ésa es la razón de
// fondo por la que el trigger de hoy es implícito, y por la que existe el gate
// `isScoped`: un criterio que se re-evalúa para siempre necesita algo que deje
// de cumplirse.
//
// Con un diff, una regla condiciona sobre `to` en vez de sobre `status`, y el
// hecho tiene identidad: pasó una vez.
//
// Es **por item** y no por batch porque así es como el dispatch entrega: el
// `start(dispatch)` de un manager llama con un item a la vez. Diffear por lote
// obligaría a un hook nuevo en `SourceDispatcher` para ganar una comparación
// que igual cuesta una lectura de una fila indexada.
import type { EngineEvent } from '@ia-flow/shared'
import { createEvent } from '@ia-flow/shared'

/** Cambió el status de un issue. Distinto de `issue.scanned`, que dice dónde
 *  está: esto dice que se movió, y de dónde. */
export const ISSUE_STATUS_CHANGED = 'issue.status_changed'

/** Un issue apareció por primera vez en el board. */
export const ISSUE_CREATED = 'issue.created'

export interface DiffItem {
  id: string
  status: string
  repos?: string[]
  projectId?: string
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
      payload: { status: item.status, item },
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
    // `from`/`to` son los nombres que una regla condiciona. `status` también
    // viaja, con el valor NUEVO, para que una condición escrita contra
    // `issue.scanned` siga significando lo mismo acá.
    payload: { from: before, to: item.status, status: item.status, item },
  })
}
