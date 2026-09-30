/**
 * Con qué criterio un host decide qué trabajo toma, además de su tope: reglas sobre las pistas de
 * la corrida ("sólo el repo X", "este agente no"). Es el `when` de los agentes, del lado del que
 * ejecuta — el único que sabe qué puede hacer su máquina (qué repos tiene, qué herramientas hay).
 * Portado de `apps/agent-host/src/admission.ts` de ia-flow v1, con el campo libre: cualquier
 * pista que el runner mande (`agentId`, `eventType`, el `scope`, `repo`, …).
 */
import type { Admission } from '@ia-flow/agent-engine'
import { z } from 'zod'
import type { AdmissionHints } from './protocol.js'

export const AdmissionRule = z.strictObject({
  /** La pista que mira (`repo`, `agentId`, `projectId`, …). */
  field: z.string().min(1),
  op: z.enum(['equals', 'notEquals', 'matches', 'notMatches']),
  /** `matches`: `*` es el único comodín. */
  value: z.string().min(1),
})
export type AdmissionRule = z.infer<typeof AdmissionRule>

/**
 * Todas las reglas tienen que pasar (AND); sin reglas se acepta todo.
 *
 * **Una regla sobre una pista que no vino no rechaza**: rechazar por falta de dato dejaría al
 * runner demorando la corrida para siempre contra un host que la hubiera tomado.
 *
 * **Vino vacía no es "no vino"**: `repo: []` es un dato, y `repo equals X` lo rechaza — si vacío
 * pasara, un host "sólo lo mío" tomaría todo lo que no es de nadie.
 */
export function evaluateAdmission(rules: AdmissionRule[], hints: AdmissionHints): Admission {
  for (const rule of rules) {
    const values = hints[rule.field]
    if (values === undefined) continue
    if (!matches(rule, values)) {
      return {
        accept: false,
        reason: `regla de admisión: ${rule.field} ${rule.op} "${rule.value}"`,
      }
    }
  }
  return { accept: true }
}

/** El `admit` de un `RemoteProviderHost` que aplica `rules` a todos sus providers. */
export function admissionRules(
  rules: AdmissionRule[],
): (request: { hints: AdmissionHints }) => Admission {
  return ({ hints }) => evaluateAdmission(rules, hints)
}

function matches(rule: AdmissionRule, values: string[]): boolean {
  const positive = rule.op === 'equals' || rule.op === 'matches'
  const hit =
    rule.op === 'equals' || rule.op === 'notEquals'
      ? values.includes(rule.value)
      : values.some((value) => glob(rule.value).test(value))
  return positive ? hit : !hit
}

function glob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}
