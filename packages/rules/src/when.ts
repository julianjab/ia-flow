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

function evalCondition(subject: Record<string, unknown>, key: string, op: string): boolean {
  const lower = key.toLowerCase()
  const snake = lower.replace(/\s+/g, '_')
  const alias = FIELD_ALIASES[lower] ?? FIELD_ALIASES[snake]
  // Fallback: source-native custom fields (e.g. GitHub Project columns like
  // `ImpProvider`, `Reviewed`, `Stage`) are exposed under `subject.fields`.
  const fields = (subject.fields as Record<string, unknown> | undefined) ?? {}
  const raw =
    subject[key] ??
    subject[lower] ??
    subject[snake] ??
    (alias ? subject[alias] : undefined) ??
    fields[key] ??
    fields[lower] ??
    fields[snake] ??
    resolvePath(subject, key)

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

export function evalWhen(subject: Record<string, unknown>, when: unknown): boolean {
  if (!when) return true

  // legacy Record format → all-AND
  if (!Array.isArray(when)) {
    return Object.entries(when as Record<string, string>).every(([key, op]) =>
      evalCondition(subject, key, op),
    )
  }

  // new array format: build OR-groups separated by logic='or'
  type Cond = { field: string; op: string; value?: string; logic?: string }
  const conds = when as Cond[]
  if (!conds.length) return true

  const groups: Cond[][] = [[]]
  for (const cond of conds) {
    if (cond.logic === 'or') groups.push([cond])
    else groups[groups.length - 1].push(cond)
  }

  return groups.some((group) => group.every((c) => evalCondition(subject, c.field, condToOp(c))))
}
