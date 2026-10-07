// Lo que la cola le dice a quien decide y que ningún dato trae armado: el «→ qué hacer» del
// detalle de cada tipo y el «✕ qué pasó / → qué hacer» de una acción que falló. Puro, sin Vue.

import type { QueueEntry } from '@/features/inbox/queue/entries'
import type { QueueType } from '@/features/inbox/queue/kinds'

const NEXT_BY_TYPE: Partial<Record<QueueType, string>> = {
  merge: 'Si el diff está bien, mergealo; si no, devolvelo a Build.',
  prd: 'Aprobarlo lo pasa a Build: lo toma el implementer en el próximo lugar libre.',
  review: 'Re-review vuelve a correr el reviewer sobre el PR.',
  answer:
    'Respondé abajo: se publica como comentario, se quita blocked y la tarea vuelve a su etapa.',
  relaunch: 'Relanzar retoma la tarea desde donde quedó: no rehace el trabajo.',
}

/** El «→ qué hacer» del detalle; nada si el tipo no tiene un paso que no sea obvio. */
export function nextOf(entry: Pick<QueueEntry, 'type' | 'item'>): string | undefined {
  if (entry.type === 'fail') {
    const by = entry.item.execution?.failure?.by
    if (by === 'runtime') return 'Falló el runner, no el código: reintentá.'
    if (by === 'agent') return 'Leé lo que dijo el agente antes de reintentar.'
    return 'Mirá el detalle técnico y reintentá.'
  }
  return NEXT_BY_TYPE[entry.type]
}

/** Una acción que no salió, dicha para quien la tocó. */
export interface ActionFailure {
  /** «✕ …»: qué pasó. */
  what: string
  /** «→ …»: qué hacer. */
  next: string
}

const NETWORK = /network error|timeout|timed out|econn|failed to fetch|socket hang up/i
const AUTH = /\b401\b|unauthori[sz]ed|bad credentials|token/i
const STALE = /\b409\b|conflict|not mergeable|already|ya no/i

/**
 * El error de una acción, legible: `label` es el botón que se tocó («Relanzar», «Mergear…») y
 * `message`, lo que devolvió el runner (o axios).
 */
export function actionFailure(label: string, message: string): ActionFailure {
  const verb = label.replace(/…$/, '').trim().toLowerCase()
  if (NETWORK.test(message))
    return {
      what: `No se pudo ${verb}: el runner no respondió (${message}).`,
      next: 'Revisá la conexión y reintentá.',
    }
  if (AUTH.test(message))
    return {
      what: `No se pudo ${verb}: GitHub no aceptó tu sesión (${message}).`,
      next: 'Volvé a iniciar sesión con GitHub y reintentá.',
    }
  if (STALE.test(message))
    return {
      what: `No se pudo ${verb}: ${message}`,
      next: 'La tarea cambió desde que cargaste la bandeja: tocá Actualizar y revisala.',
    }
  return {
    what: `No se pudo ${verb}: ${message}`,
    next: 'Reintentá; si vuelve a fallar, abrila en el asistente.',
  }
}

/**
 * Lo que no se pudo LEER (el board, el detalle de una tarea), dicho igual que una acción que
 * falló: `subject` es lo que se pedía («leer el board»).
 */
export function loadFailure(subject: string, message: string): ActionFailure {
  if (NETWORK.test(message))
    return {
      what: `No se pudo ${subject}: el runner no respondió (${message}).`,
      next: 'Revisá la conexión y reintentá.',
    }
  return {
    what: `No se pudo ${subject}: ${message}`,
    next: 'Reintentá; si persiste, revisá que el runner esté corriendo.',
  }
}
