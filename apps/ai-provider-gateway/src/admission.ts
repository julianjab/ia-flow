// Con qué criterio ESTE gateway decide si toma una tarea.
//
// Hasta acá la única regla era un contador (`running < maxConcurrentRuns`).
// El cap sigue siendo eso, pero ahora convive con reglas sobre la tarea que
// llega: "sólo el repo X", "este agente no". Es la misma idea que el `when`
// de los agentes del engine, del lado del que ejecuta en vez del que
// despacha — y por la misma razón: el gateway es el único que sabe qué puede
// hacer su máquina (qué repos tiene clonados, qué herramientas hay).
//
// Módulo puro a propósito: sin fetch, sin fs, sin env. Es lo que hace
// testeable la parte que decide, que es la única que puede frenar el
// pipeline en silencio.

export const ADMISSION_FIELDS = ['repo', 'agentId', 'projectId', 'taskType'] as const
export const ADMISSION_OPS = ['equals', 'notEquals', 'matches', 'notMatches'] as const

export type AdmissionField = (typeof ADMISSION_FIELDS)[number]
export type AdmissionOp = (typeof ADMISSION_OPS)[number]

export interface AdmissionRule {
  field: AdmissionField
  op: AdmissionOp
  value: string
}

/**
 * Lo que se sabe de la tarea al evaluar. Todo opcional: `/v1/capacity` es una
 * sonda sin cuerpo, así que a veces sólo llegan pistas (o ninguna).
 */
export interface AdmissionSubject {
  repos?: string[]
  agentId?: string
  projectId?: string
  taskType?: string
}

export interface AdmissionVerdict {
  accepting: boolean
  reason?: string
}

/** `*` es el único comodín — el mismo que ya usan los nombres de repo. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** Los valores que esa tarea trae para ese campo (repo puede traer varios). */
function valuesFor(field: AdmissionField, subject: AdmissionSubject): string[] {
  if (field === 'repo') return subject.repos ?? []
  const single = subject[field]
  return single ? [single] : []
}

function matchesRule(rule: AdmissionRule, values: string[]): boolean {
  const positive = rule.op === 'equals' || rule.op === 'matches'
  const hit =
    rule.op === 'equals' || rule.op === 'notEquals'
      ? values.includes(rule.value)
      : values.some((v) => globToRegExp(rule.value).test(v))
  return positive ? hit : !hit
}

export function isAdmissionRule(value: unknown): value is AdmissionRule {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    ADMISSION_FIELDS.includes(r.field as AdmissionField) &&
    ADMISSION_OPS.includes(r.op as AdmissionOp) &&
    typeof r.value === 'string' &&
    r.value.length > 0
  )
}

/**
 * ¿Aceptamos esta tarea? Todas las reglas tienen que pasar (AND) — sin reglas
 * se acepta todo, que es como se comportaba el gateway antes de que esto
 * existiera.
 *
 * **Una regla sobre un campo que la tarea no trae NO rechaza.** Pasa siempre
 * en la sonda `/v1/capacity`, que no tiene cuerpo: rechazar ahí por falta de
 * dato dejaría al daemon difiriendo el issue para siempre contra un gateway
 * que en realidad lo hubiera tomado. La regla se evalúa de verdad en
 * `/v1/run`, que sí tiene la tarea entera.
 */
export function evaluateAdmission(
  rules: AdmissionRule[],
  subject: AdmissionSubject,
): AdmissionVerdict {
  for (const rule of rules) {
    const values = valuesFor(rule.field, subject)
    if (values.length === 0) continue
    if (!matchesRule(rule, values)) {
      return {
        accepting: false,
        reason: `regla de admisión: ${rule.field} ${rule.op} "${rule.value}"`,
      }
    }
  }
  return { accepting: true }
}
