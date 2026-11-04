/**
 * Los webhooks que son eco de lo que hizo el propio runner y no le dicen nada a nadie: se
 * descartan en el borde, antes de cualquier lectura a GitHub (el intake lee la card por GraphQL,
 * la bandeja relee el board). Puro: decide con el delivery tal cual llegó.
 *
 * Hoy, uno solo: la marca "en curso" (`workingMarker`) que el runner pone y saca de la card. Cada
 * cambio vuelve como un `projects_v2_item` `edited` del campo `Working`; las pipelines ya lo
 * excluían en su `when`, pero recién después de que el intake leyera la card — dos lecturas por
 * marca, en medio de las ráfagas que disparaban el límite secundario de GitHub.
 */
import type { Delivery } from './dispatch.js'

/** Por qué `delivery` es un eco de la marca del propio runner, o `undefined` si no lo es.
 *  `markerFields`: el campo de la marca de cada proyecto; `ownSenders`: los logins del runner. */
export function markerEcho(
  delivery: Delivery,
  markerFields: ReadonlySet<string>,
  ownSenders: RegExp,
): string | undefined {
  if (delivery.event !== 'projects_v2_item' || delivery.payload.action !== 'edited')
    return undefined
  const changes = delivery.payload.changes as { field_value?: { field_name?: unknown } } | undefined
  const field = changes?.field_value?.field_name
  if (typeof field !== 'string') return undefined
  const fieldLower = field.toLowerCase()
  if (![...markerFields].some((marker) => marker.toLowerCase() === fieldLower)) return undefined
  const sender = (delivery.payload.sender as { login?: unknown } | undefined)?.login
  if (typeof sender !== 'string' || !ownSenders.test(sender)) return undefined
  return `eco de la marca ${field} (${sender})`
}
