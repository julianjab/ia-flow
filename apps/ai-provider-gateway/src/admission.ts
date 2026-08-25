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

export const ADMISSION_FIELDS = ['repo', 'agentId', 'projectId', 'taskType', 'assignee'] as const
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
  /** Logins asignados al issue. Es lo que permite que una máquina personal
   *  declare "sólo tomo los issues de su dueño" — un hecho del provider, no
   *  del pipeline (el fallback a otro provider lo decide el agente). */
  assignees?: string[]
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

/** Los valores que esa tarea trae para ese campo (repo y assignee pueden
 *  traer varios). `undefined` = el dato no vino (sonda sin pistas, daemon
 *  viejo) y la regla se saltea; `[]` = vino y está VACÍO (issue sin
 *  asignar), y una regla positiva sobre él sí rechaza. */
function valuesFor(field: AdmissionField, subject: AdmissionSubject): string[] | undefined {
  if (field === 'repo') return subject.repos
  if (field === 'assignee') return subject.assignees
  const single = subject[field]
  return single === undefined ? undefined : [single]
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
 * **Una regla sobre un campo DESCONOCIDO no rechaza.** Una sonda sin pistas
 * (daemon viejo) no trae nada: rechazar ahí por falta de dato dejaría al
 * daemon difiriendo el issue para siempre contra un gateway que en realidad
 * lo hubiera tomado. La evaluación completa ocurre con las pistas de la
 * query o con la tarea entera de `/v1/run`.
 *
 * **Conocido-vacío NO es desconocido.** Un issue sin asignar llega como
 * `assignees: []` y una regla `assignee equals X` lo rechaza — si "vacío"
 * pasara, un gateway "sólo los issues de mi dueño" tomaría todo lo que nadie
 * reclamó, que es lo contrario de lo que la regla declara.
 */
export function evaluateAdmission(
  rules: AdmissionRule[],
  subject: AdmissionSubject,
): AdmissionVerdict {
  for (const rule of rules) {
    const values = valuesFor(rule.field, subject)
    if (values === undefined) continue
    if (!matchesRule(rule, values)) {
      return {
        accepting: false,
        reason: `regla de admisión: ${rule.field} ${rule.op} "${rule.value}"`,
      }
    }
  }
  return { accepting: true }
}
