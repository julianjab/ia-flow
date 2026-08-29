// Matcher de esperas.
//
// Una espera es una REGLA EFÍMERA, de un solo uso, con scope de task. Se evalúa
// con el mismo `evalWhen` que una regla; las dos diferencias son que se consume
// al matchear y que vence. Por eso esto es un módulo de treinta líneas y no un
// mecanismo aparte.
import type { EngineEvent, Wait } from '@ia-flow/shared'
import { evalWhen } from './when.js'

/** ¿Este evento despierta esta espera?
 *
 *  El scope es de TASK, no de proyecto: un `ci.finished` de otro PR no puede
 *  despertar una espera que se armó para el PR de esta task. Ése es el filtro
 *  que hace que esperar sea seguro con varias tasks en vuelo. */
export function matchesWait(wait: Wait, event: EngineEvent, now: number): boolean {
  if (Date.parse(wait.expiresAt) <= now) return false
  if (!wait.on.includes(event.type)) return false
  if (event.scope.projectId && event.scope.projectId !== wait.projectId) return false
  // `issueId` es el ancla: cuando el evento lo trae, tiene que ser el de la
  // task que espera. Un evento sin issueId (un `ci.finished` que GitHub no
  // pudo atar a un PR) igual puede despertarla si las condiciones dan — es la
  // fuga deliberada que permite esperar por branch.
  if (event.scope.issueId && event.scope.issueId !== wait.taskId) return false
  return evalWhen(event.payload, wait.when)
}

/** Las que este evento despierta, en orden de creación (la más vieja primero:
 *  si dos esperas de la misma task matchean, la primera en armarse es la que
 *  el agente pidió antes). */
export function matchWaits(
  waits: readonly Wait[],
  event: EngineEvent,
  now: number = Date.now(),
): Wait[] {
  return waits
    .filter((w) => matchesWait(w, event, now))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Las vencidas. El barrido las consume y emite `wait.expired` por cada una —
 *  qué hacer con un timeout lo decide una regla, no este módulo. */
export function expiredWaits(waits: readonly Wait[], now: number = Date.now()): Wait[] {
  return waits.filter((w) => Date.parse(w.expiresAt) <= now)
}

/** Una pausa es una espera con checkpoint. No hay un tipo aparte: la distinción
 *  es de datos, y preguntarla acá evita que cada consumidor invente su propio
 *  criterio. */
export function isPause(wait: Wait): boolean {
  return wait.checkpoint != null
}
