/**
 * El orden de las decisiones de la bandeja por palanca: lo que más acerca a Done y lo que más
 * destraba, primero — y por qué, en lenguaje de producto. Puro: recibe los items ya armados (con
 * `unlocks` calculado) y devuelve otra lista.
 */
import type { InboxItem, InboxKind } from '@ia-flow/shared'
import { inboxOrder } from './classify.js'

/** Cercanía a Done de cada caso de decisión: menor, más cerca. */
const NEARNESS: Partial<Record<InboxKind, number>> = {
  merge: 0,
  review: 1,
  prd: 2,
  doubt: 3,
  crash: 4,
  prerequisite: 5,
  stale: 6,
}

/** Por qué un caso está donde está. */
const KIND_REASON: Partial<Record<InboxKind, string>> = {
  merge: 'a un merge de Done',
  review: 'a una revisión del merge',
  prd: 'espera tu aprobación del PRD para pasar a Build',
  doubt: 'el agente espera tu respuesta para seguir',
  prerequisite: 'le falta una pieza para seguir',
  stale: 'lleva rato sin moverse',
}

function isDecision(item: InboxItem): boolean {
  return item.group === 'need' || item.group === 'fail'
}

function failedBy(item: InboxItem): 'agent' | 'runtime' | undefined {
  return item.execution?.failure?.by
}

/** La regla, lexicográfica: cercanía a Done, más `unlocks`, el runner antes que el agente, lo más
 *  viejo. */
function byLeverage(a: InboxItem, b: InboxItem): number {
  const runtimeFirst = (item: InboxItem) => (failedBy(item) === 'runtime' ? 0 : 1)
  return (
    (NEARNESS[a.kind] ?? Number.MAX_SAFE_INTEGER) - (NEARNESS[b.kind] ?? Number.MAX_SAFE_INTEGER) ||
    (b.unlocks ?? 0) - (a.unlocks ?? 0) ||
    runtimeFirst(a) - runtimeFirst(b) ||
    a.since.localeCompare(b.since)
  )
}

/** Las razones de una decisión: siempre al menos una. */
function reasonsOf(item: InboxItem): string[] {
  const reasons: string[] = []
  const kind = KIND_REASON[item.kind]
  if (kind) reasons.push(kind)
  const unlocks = item.unlocks ?? 0
  if (unlocks > 0) reasons.push(`destraba ${unlocks} ${unlocks === 1 ? 'tarea' : 'tareas'}`)
  if (item.group === 'fail') {
    const failure = failureReason(item)
    if (failure) reasons.push(failure)
  }
  return reasons.length > 0 ? reasons : [item.why]
}

/** Quién falló, sólo si se sabe: sin `failure.by` no se inventa un culpable. */
function failureReason(item: InboxItem): string | undefined {
  const by = failedBy(item)
  if (by === 'runtime') return 'falló el runner, no el agente'
  if (by === 'agent') return 'falló el agente'
  return item.execution ? 'falló la última corrida' : undefined
}

/**
 * Las decisiones (`need` + `fail`, juntas) primero, por palanca, cada una con su `priority` (1, 2…)
 * y sus `reasons`; después lo que corre o espera turno, en el orden de siempre y sin `priority`.
 */
export function prioritize(items: InboxItem[]): InboxItem[] {
  const decisions = items
    .filter(isDecision)
    .sort(byLeverage)
    .map((item, index) => ({ ...item, priority: index + 1, reasons: reasonsOf(item) }))
  const rest = items
    .filter((item) => !isDecision(item))
    .sort(inboxOrder)
    .map(({ priority: _priority, reasons: _reasons, ...item }) => item)
  return [...decisions, ...rest]
}
