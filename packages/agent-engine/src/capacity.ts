// Caps de concurrencia — cuántos runs pueden estar en vuelo a la vez, por
// agente y por provider.
//
// Los tres scopes que existen hoy y dónde se evalúa cada uno:
//
//   proyecto  → SourceDispatcher.atCapacity (@ia-flow/issue-sources)
//               difiere el item antes de que llegue al dispatcher.
//   agente    → TaskDispatcher (pre-check barato) + AgentOrchestrator
//               (autoritativo, contra el agente que realmente va a correr).
//   provider  → resolveProvider (provider-selection.ts) — el único que en vez
//               de diferir prueba el SIGUIENTE candidato.
//
// Este archivo es puro: cuenta sobre un snapshot del registry de pending
// tasks (una entrada aparece ahí justo antes de la llamada al provider, ver
// Agent.run) y no hace I/O. Los caps se leen de config; el conteo, del
// runtime.

import type { PendingTask } from './pending-tasks.js'
import { listPendingTasks } from './pending-tasks.js'

/** Lectura del registry de runs en vuelo. Inyectable para poder testear los
 *  gates sin tocar el singleton compartido. */
export type PendingSnapshot = () => Array<[string, PendingTask]>

export const defaultPendingSnapshot: PendingSnapshot = () => listPendingTasks()

/**
 * Un cap de `0` (o ausente) significa **sin límite**, no "frenar todo".
 * Misma decisión que el knob de env (ver dispatch/env.ts en
 * @ia-flow/issue-sources): un 0 que congela cada dispatch es un footgun —
 * el item quedaría difiriéndose para siempre detrás de una condición que
 * nunca puede despejarse. Para pausar un proyecto está polling-pause.
 */
export function isUnlimited(cap: number | undefined): boolean {
  return cap == null || cap <= 0
}

/** True cuando el cap está definido y ya está saturado. */
export function atCap(running: number, cap: number | undefined): boolean {
  return !isUnlimited(cap) && running >= (cap as number)
}

export function countRunningByAgent(
  agentId: string,
  snapshot: PendingSnapshot = defaultPendingSnapshot,
): number {
  let n = 0
  for (const [, pending] of snapshot()) if (pending.agentId === agentId) n++
  return n
}

export function countRunningByProvider(
  providerId: string,
  snapshot: PendingSnapshot = defaultPendingSnapshot,
): number {
  let n = 0
  for (const [, pending] of snapshot()) if (pending.providerId === providerId) n++
  return n
}
