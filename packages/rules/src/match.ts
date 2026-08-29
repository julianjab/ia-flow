// Selección de reglas — el análogo de `selectAgent`, generalizado.
//
// Diferencia semántica importante y fácil de pasar por alto: `selectAgent`
// ordena candidatos y corre **el primero**. Acá disparan **todas** las que
// matchean, que es lo que permite que un PR detone dos acciones. La contracara
// es que dos reglas mal configuradas pueden lanzar dos agentes sobre la misma
// task; `exclusive: true` recupera el comportamiento viejo cuando se lo quiere.
//
// Los cuatro filtros son predicados sobre datos ya en memoria, así que este
// módulo no tiene I/O y se puede testear sin levantar nada. El quinto —
// `whenText`, que necesita que un modelo lea el evento— vive afuera
// envolviéndolo, igual que `agent-text-gate.ts` envuelve a `selectAgent`.
import type { EngineEvent, Rule } from '@ia-flow/shared'
import { matchScope } from './scope.js'
import { evalWhen } from './when.js'

/** Filtro que descartó a una regla. El orden del union es el de evaluación.
 *  `whenText` no se decide acá — lo produce el gate semántico, que es impuro.
 *  Comparte el tipo para que el log de descartes sea uno solo. */
export type RuleRejectionReason = 'disabled' | 'type' | 'scope' | 'when' | 'whenText' | 'exclusive'

export interface RejectedRule {
  id: string
  reason: RuleRejectionReason
}

export interface RuleMatchInput {
  event: EngineEvent
  rules: readonly Rule[]
}

export interface RuleMatchResult {
  /** Las que disparan, en orden de ejecución. */
  matched: Rule[]
  rejected: RejectedRule[]
}

function matchesType(rule: Rule, event: EngineEvent): boolean {
  return rule.on.includes(event.type)
}

/**
 * Orden de evaluación: **especificidad primero, `position` después.**
 *
 * Mismo criterio que `selectAgentCandidates`, y por la misma razón no obvia:
 * cada ámbito numera sus posiciones de forma independiente, así que comparar
 * posiciones entre ámbitos no significa nada — reordenar las reglas globales
 * las dejaría en 0..n-1 y se colarían delante de las de proyecto que viven en
 * 7, 8, 9. Una regla de repo es más específica que una de proyecto, y ésta que
 * una global. `id` cierra el desempate para que el orden sea reproducible.
 */
function specificity(rule: Rule): number {
  if (rule.repoName) return 0
  if (rule.projectId) return 1
  return 2
}

export function matchRules({ event, rules }: RuleMatchInput): RuleMatchResult {
  const rejected: RejectedRule[] = []
  const matched: Rule[] = []

  // Copia antes de ordenar: el array suele venir de un repositorio y no es
  // nuestro para mutar.
  const ordered = [...rules].sort((a, b) => {
    const bySpecificity = specificity(a) - specificity(b)
    if (bySpecificity !== 0) return bySpecificity
    const byPosition = (a.position ?? 0) - (b.position ?? 0)
    if (byPosition !== 0) return byPosition
    return a.id.localeCompare(b.id)
  })

  let stopped = false
  for (const rule of ordered) {
    if (stopped) {
      rejected.push({ id: rule.id, reason: 'exclusive' })
      continue
    }
    if (rule.enabled === false) {
      rejected.push({ id: rule.id, reason: 'disabled' })
      continue
    }
    if (!matchesType(rule, event)) {
      rejected.push({ id: rule.id, reason: 'type' })
      continue
    }
    if (!matchScope({ projectId: rule.projectId, repoName: rule.repoName }, event.scope)) {
      rejected.push({ id: rule.id, reason: 'scope' })
      continue
    }
    if (!evalWhen(event.payload, rule.when)) {
      rejected.push({ id: rule.id, reason: 'when' })
      continue
    }
    matched.push(rule)
    // `exclusive` corta a las de MENOR prioridad, no a las ya matcheadas: es
    // "yo me hago cargo de esto", no "nadie más existe".
    if (rule.exclusive) stopped = true
  }

  return { matched, rejected }
}

/** Resumen legible de los descartes para el log. Agrupa por filtro para que la
 *  línea diga "cayeron 4 por type, 1 por scope" en vez de listar 40 ids. */
export function summarizeRuleRejections(rejected: readonly RejectedRule[]): string {
  if (!rejected.length) return 'sin candidatas'
  const byReason = new Map<RuleRejectionReason, string[]>()
  for (const r of rejected) {
    const bucket = byReason.get(r.reason)
    if (bucket) bucket.push(r.id)
    else byReason.set(r.reason, [r.id])
  }
  return [...byReason.entries()].map(([reason, ids]) => `${reason}: ${ids.join(', ')}`).join(' | ')
}
