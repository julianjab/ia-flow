// Evaluador puro del DSL `when` (packages/shared/src/schemas.ts → WhenConditionSchema).
//
// Vivía en `@ia-flow/issue-sources/dispatch/when.ts`, que a su vez lo había
// recibido de `agent-engine`. Su hogar es acá: sus consumidores son la
// selección de agentes, el filtro de proyectos y el matcher de reglas, y
// ninguno de los tres es dueño de los otros dos. `issue-sources` lo re-exporta
// para no romper los imports existentes.
//
// El sujeto es un objeto plano cualquiera: una `Task` cuando lo usa la
// selección de agentes, el payload de un `EngineEvent` cuando lo usa una regla.
// El evaluador no sabe cuál de los dos es, y eso es lo que lo hace reusable.

// GitHub Project field names differ from Task object keys — map the common ones.
const FIELD_ALIASES: Record<string, string> = {
  'task type': 'type',
  task_type: 'type',
  // GitHub Project v2 built-in fields → Task top-level keys we populate from
  // the source. Their values don't come through as `ProjectV2ItemField*Value`
  // in our GraphQL query (they're `RepositoryValue` / `LabelsValue` /
  // `UsersValue`), so `fields[...]` is empty; alias them to the top-level
  // Task keys we already expose. `repository` maps to the `repos[]` array —
  // evalCondition handles array membership natively, so `when: {field:
  // "repository", op: "=", value: "X"}` resolves to `task.repos.includes("X")`.
  repository: 'repos',
  labels: 'labels',
  assignees: 'assignees',
}

/**
 * Operadores con argumento, codificados como `$op:valor` en la forma string.
 *
 * `condToOp` los produce desde la forma estructurada `{field, op, value}`, y el
 * formato Record legacy (`{additions: '$gt:500'}`) los acepta directo — es el
 * mismo string en los dos caminos, así que no hay dos gramáticas que mantener.
 */
const PREFIXED_OPS = ['$ne', '$gt', '$gte', '$lt', '$lte', '$contains', '$matches'] as const

/** Operadores de la forma estructurada → su prefijo codificado. */
const OP_ENCODING: Record<string, string> = {
  '!=': '$ne',
  '>': '$gt',
  '>=': '$gte',
  '<': '$lt',
  '<=': '$lte',
  $contains: '$contains',
  $matches: '$matches',
}

export function condToOp(c: { op: string; value?: string }): string {
  if (c.op === '$null' || c.op === '$not_null') return c.op
  const prefix = OP_ENCODING[c.op]
  if (prefix) return `${prefix}:${c.value ?? ''}`
  return c.value ?? ''
}

/** Parte `$gt:500` en `['$gt', '500']`. `null` si el op no lleva prefijo. */
function splitOp(op: string): [string, string] | null {
  for (const prefix of PREFIXED_OPS) {
    if (op.startsWith(`${prefix}:`)) return [prefix, op.slice(prefix.length + 1)]
  }
  return null
}

/**
 * Camino anidado (`pr.head.ref`) sobre el sujeto.
 *
 * Sólo se intenta cuando las búsquedas planas fallaron. Como ninguna clave del
 * vocabulario existente tiene punto, esto no puede cambiar el resultado de una
 * config ya escrita: es puramente aditivo, y es lo que permite que una regla
 * condicione sobre el payload anidado de un webhook.
 */
function resolvePath(subject: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return undefined
  let current: unknown = subject
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Compara como números. Si alguno de los dos no lo es, la condición no aplica
 *  (false) en vez de degradar a comparación de strings, que daría resultados
 *  sorprendentes: `'10' < '9'` es true lexicográficamente. */
function compareNumeric(raw: unknown, operand: string, cmp: (a: number, b: number) => boolean) {
  const left = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  const right = Number(operand.trim())
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false
  return cmp(left, right)
}

/**
 * Resuelve el valor de `key` contra el sujeto: exacto, lower/snake case,
 * alias, `subject.fields` (custom fields del source), y por último un camino
 * anidado (`pr.head.ref`). Extraído de `evalCondition` para que `traceWhen`
 * pueda mostrar QUÉ resolvió antes de comparar, sin reimplementar la
 * búsqueda — no puede divergir de lo que `evalCondition` usa para decidir.
 */
function resolveFieldValue(subject: Record<string, unknown>, key: string): unknown {
  const lower = key.toLowerCase()
  const snake = lower.replace(/\s+/g, '_')
  const alias = FIELD_ALIASES[lower] ?? FIELD_ALIASES[snake]
  // Fallback: source-native custom fields (e.g. GitHub Project columns like
  // `ImpProvider`, `Reviewed`, `Stage`) are exposed under `subject.fields`.
  const fields = (subject.fields as Record<string, unknown> | undefined) ?? {}
  return (
    subject[key] ??
    subject[lower] ??
    subject[snake] ??
    (alias ? subject[alias] : undefined) ??
    fields[key] ??
    fields[lower] ??
    fields[snake] ??
    resolvePath(subject, key)
  )
}

function evalCondition(subject: Record<string, unknown>, key: string, op: string): boolean {
  const raw = resolveFieldValue(subject, key)

  if (op === '$null') {
    if (raw == null) return true
    if (Array.isArray(raw)) return raw.length === 0
    return String(raw) === ''
  }
  if (op === '$not_null') {
    if (raw == null) return false
    if (Array.isArray(raw)) return raw.length > 0
    return String(raw) !== ''
  }

  const prefixed = splitOp(op)
  if (prefixed) {
    const [prefix, operand] = prefixed
    switch (prefix) {
      case '$gt':
        return compareNumeric(raw, operand, (a, b) => a > b)
      case '$gte':
        return compareNumeric(raw, operand, (a, b) => a >= b)
      case '$lt':
        return compareNumeric(raw, operand, (a, b) => a < b)
      case '$lte':
        return compareNumeric(raw, operand, (a, b) => a <= b)
      case '$contains': {
        const needle = operand.toLowerCase()
        // Arrays: pertenencia, misma semántica que `=` sobre un array.
        if (Array.isArray(raw)) return raw.map((v) => String(v).toLowerCase()).includes(needle)
        return String(raw ?? '')
          .toLowerCase()
          .includes(needle)
      }
      case '$matches': {
        // Una regex inválida es un error de config, no del sujeto: no matchea
        // en vez de tirar y voltear el dispatch entero.
        let re: RegExp
        try {
          re = new RegExp(operand)
        } catch {
          return false
        }
        if (Array.isArray(raw)) return raw.some((v) => re.test(String(v)))
        return re.test(String(raw ?? ''))
      }
      case '$ne':
        if (Array.isArray(raw)) return !raw.map(String).includes(operand)
        return (raw == null ? '' : String(raw)) !== operand
    }
  }

  // Igualdad (el op pelado es el valor esperado).
  // Arrays (labels, assignees) → membership semantics.
  if (Array.isArray(raw)) return raw.map(String).includes(op)
  return (raw == null ? '' : String(raw)) === op
}

type RawCond = { field: string; op: string; value?: string; logic?: string }

/** Una condición ya normalizada a la forma que `evalCondition` entiende: el
 *  `op` legacy viaja tal cual codificado (`$ne:foo`); el de la forma
 *  estructurada pasa por `condToOp`. `evalWhen` y `traceWhen` comparten esto
 *  para no poder divergir en cómo arman los grupos OR/AND. */
interface EncodedCond {
  field: string
  /** Humano, para mostrar en un log (`'!='`, `'='`, o el string legacy tal
   *  cual si no hay operador estructurado separado). */
  op: string
  value?: string
  /** Lo que realmente evalúa `evalCondition`. */
  encodedOp: string
}

function toConditionGroups(when: unknown): EncodedCond[][] {
  if (!when) return []

  // legacy Record format → un solo grupo, todo-AND
  if (!Array.isArray(when)) {
    const entries = Object.entries(when as Record<string, string>)
    if (!entries.length) return []
    return [entries.map(([field, op]) => ({ field, op, encodedOp: op }))]
  }

  // new array format: build OR-groups separated by logic='or'
  const conds = when as RawCond[]
  if (!conds.length) return []

  const groups: RawCond[][] = [[]]
  for (const cond of conds) {
    if (cond.logic === 'or') groups.push([cond])
    else groups[groups.length - 1].push(cond)
  }

  return groups.map((group) =>
    group.map((c) => ({ field: c.field, op: c.op, value: c.value, encodedOp: condToOp(c) })),
  )
}

export function evalWhen(subject: Record<string, unknown>, when: unknown): boolean {
  const groups = toConditionGroups(when)
  if (!groups.length) return true
  return groups.some((group) => group.every((c) => evalCondition(subject, c.field, c.encodedOp)))
}

/** Una condición evaluada, con lo que se comparó — no sólo si matcheó. */
export interface WhenConditionTrace {
  field: string
  op: string
  value?: string
  /** Lo que el sujeto resolvió para `field` ANTES de comparar. `undefined`
   *  es la señal más común de "este evento no trae ese campo" — el caso que
   *  dejaba al reviewer sin re-tomar #1317: `item.status` contra un payload
   *  de `issues.unlabeled`, que nunca trae `item`. */
  actual: unknown
  matched: boolean
}

export interface WhenTrace {
  matched: boolean
  /** Un array por grupo OR; cada grupo son sus condiciones AND, en el orden
   *  en que se declararon. Vacío cuando el `when` no tiene condiciones. */
  groups: WhenConditionTrace[][]
}

/**
 * Variante de `evalWhen` para diagnóstico: además del boolean, devuelve QUÉ
 * condición falló y con qué valor resolvió el sujeto — es lo que permite
 * loguear POR QUÉ un `when` rechazó una regla, no sólo QUE la rechazó.
 *
 * Comparte `toConditionGroups`/`evalCondition`/`resolveFieldValue` con
 * `evalWhen`, así que `traceWhen(...).matched` no puede divergir de
 * `evalWhen(...)` — no es una segunda implementación del DSL, es
 * instrumentación sobre la misma.
 */
export function traceWhen(subject: Record<string, unknown>, when: unknown): WhenTrace {
  const groups = toConditionGroups(when)
  if (!groups.length) return { matched: true, groups: [] }

  const tracedGroups = groups.map((group) =>
    group.map((c) => ({
      field: c.field,
      op: c.op,
      value: c.value,
      actual: resolveFieldValue(subject, c.field),
      matched: evalCondition(subject, c.field, c.encodedOp),
    })),
  )

  return {
    matched: tracedGroups.some((group) => group.every((c) => c.matched)),
    groups: tracedGroups,
  }
}

/**
 * Cross-product AND-merge de varias fuentes `when` en un solo array de grupos
 * OR/AND. Cada fuente puede traer sus propios OR-groups (`toConditionGroups`);
 * mergearlas linealmente (concatenar el array crudo) sólo ANDearía la última
 * fuente al último grupo OR de la primera, rompiendo el resto. El cross-product
 * preserva la semántica: `(A or B) AND (C or D)` evalúa correctamente como
 * `(A∧C) or (A∧D) or (B∧C) or (B∧D)`.
 *
 * Una fuente sin condiciones (`when` vacío/ausente) no restringe nada y se
 * saltea — es lo que hace que un `baseWhen` de proyecto opcional no invente
 * una condición cuando nadie configuró una.
 */
function mergeConditionGroups(whens: readonly unknown[]): EncodedCond[][] {
  let acc: EncodedCond[][] | null = null
  for (const w of whens) {
    const groups = toConditionGroups(w)
    if (!groups.length) continue
    acc = acc ? acc.flatMap((a) => groups.map((g) => [...a, ...g])) : groups
  }
  return acc ?? []
}

/**
 * Variante de `evalWhen` que ANDea varias fuentes `when` antes de evaluar —
 * pensada para combinar el `when` propio de una regla con un `baseWhen`
 * compartido por scope (proyecto/global). Comparte `toConditionGroups` /
 * `evalCondition` con `evalWhen`/`traceWhen`, así que no puede divergir en
 * cómo resuelve cada fuente individualmente.
 */
export function evalWhenAll(
  subject: Record<string, unknown>,
  ...whens: readonly unknown[]
): boolean {
  const groups = mergeConditionGroups(whens)
  if (!groups.length) return true
  return groups.some((group) => group.every((c) => evalCondition(subject, c.field, c.encodedOp)))
}

/** Variante de `traceWhen` que ANDea varias fuentes `when` — ver `evalWhenAll`. */
export function traceWhenAll(
  subject: Record<string, unknown>,
  ...whens: readonly unknown[]
): WhenTrace {
  const groups = mergeConditionGroups(whens)
  if (!groups.length) return { matched: true, groups: [] }

  const tracedGroups = groups.map((group) =>
    group.map((c) => ({
      field: c.field,
      op: c.op,
      value: c.value,
      actual: resolveFieldValue(subject, c.field),
      matched: evalCondition(subject, c.field, c.encodedOp),
    })),
  )

  return {
    matched: tracedGroups.some((group) => group.every((c) => c.matched)),
    groups: tracedGroups,
  }
}
