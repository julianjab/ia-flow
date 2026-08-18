import type { ITaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { createLogger } from './logger.js'

const log = createLogger('outcomes')

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
 * Calcula el set final de labels aplicando las operaciones del DSL sobre las
 * labels actuales. Puro y exportado para poder testearlo sin fuente.
 *
 * Gramática: `$labels:+añadir,-quitar,=reemplazar` (los tokens pueden venir
 * mezclados y repetidos). Semántica:
 *
 *   · Si hay al menos un token `=`, la base es exactamente ese conjunto — es
 *     la fila "Reemplazar por" de la UI, que define el set completo. Un `=`
 *     pelado (sin nombre) borra todas las labels.
 *   · Si no, la base son las labels actuales de la task.
 *   · Sobre esa base se aplican los `+` y después los `-`, de modo que quitar
 *     gana sobre añadir si alguien declara ambos para la misma label.
 *
 * Un token sin prefijo se trata como `+`: es el error de tipeo más probable y
 * "añadir" es la interpretación segura (no destruye labels existentes).
 */
export function applyLabelOps(current: string[], spec: string): string[] {
  const tokens = spec
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  const replace: string[] = []
  // Separado de `replace.length` a propósito: un `=` pelado significa
  // "reemplazar por nada" (borrar todas), que es distinto de no traer ningún
  // token `=`. Sin esta bandera, borrar todo sería inexpresable.
  let hasReplace = false
  const add: string[] = []
  const remove = new Set<string>()

  for (const token of tokens) {
    const prefix = token[0]
    const name = token.slice(1).trim()
    if (prefix === '=') {
      hasReplace = true
      if (name) replace.push(name)
    } else if (prefix === '-') {
      if (name) remove.add(name)
    } else if (prefix === '+') {
      if (name) add.push(name)
    } else {
      add.push(token)
    }
  }

  const base = hasReplace ? replace : current
  const result: string[] = []
  for (const label of [...base, ...add]) {
    if (!remove.has(label) && !result.includes(label)) result.push(label)
  }
  return result
}

/**
 * Applies an outcome string to a task via the manager.
 *
 * Supported forms:
 *   · "SomeStatus"                 → applyTransition(task, "SomeStatus")
 *   · "$set:field=value,f2=v2"     → setFields(task, {...}), status also
 *                                    handled by applyTransition when set.
 *   · "$labels:+a,-b,=c"           → setLabels(task, <set final>) — ver
 *                                    `applyLabelOps` para la semántica.
 */
export async function applyOutcome(
  task: Task,
  outcome: string,
  manager: ITaskSource,
): Promise<Task> {
  if (outcome.startsWith('$set:')) {
    const pairs = outcome
      .slice(5)
      .split(',')
      .map((pair) => {
        const eq = pair.indexOf('=')
        return eq >= 0 ? { field: pair.slice(0, eq), value: pair.slice(eq + 1) } : null
      })
      .filter((p): p is { field: string; value: string } => p !== null && !!p.field)

    const extraFields: Record<string, string> = {}
    for (const { field, value } of pairs) {
      if (field.toLowerCase() === 'status') {
        task = await manager.applyTransition(task, value)
      } else {
        extraFields[field] = value
      }
    }
    if (Object.keys(extraFields).length > 0) {
      task = manager.setFields
        ? await manager.setFields(task, extraFields)
        : ({ ...task, ...extraFields } as Task)
    }
    return task
  }

  if (outcome.startsWith('$labels:')) {
    // Sin esta rama, un `$labels:` caía al `applyTransition` de abajo e
    // intentaba mover el issue a un status llamado literalmente
    // "$labels:-ci-checked". El DSL se serializaba en la UI pero nadie lo
    // interpretaba del lado del runtime.
    const desired = applyLabelOps(task.labels ?? [], outcome.slice(8))
    if (!manager.setLabels) {
      log.warn(
        { taskId: task.id, outcome },
        'El source no soporta setLabels — outcome de labels ignorado',
      )
      return task
    }
    return manager.setLabels(task, desired)
  }

  return manager.applyTransition(task, outcome)
}

export function condToOp(c: { op: string; value?: string }): string {
  if (c.op === '$null' || c.op === '$not_null') return c.op
  if (c.op === '!=') return `$ne:${c.value ?? ''}`
  return c.value ?? ''
}

function evalCondition(task: Record<string, unknown>, key: string, op: string): boolean {
  const lower = key.toLowerCase()
  const snake = lower.replace(/\s+/g, '_')
  const alias = FIELD_ALIASES[lower] ?? FIELD_ALIASES[snake]
  // Fallback: source-native custom fields (e.g. GitHub Project columns like
  // `ImpProvider`, `Reviewed`, `Stage`) are exposed under `task.fields`.
  const fields = (task.fields as Record<string, unknown> | undefined) ?? {}
  const raw =
    task[key] ??
    task[lower] ??
    task[snake] ??
    (alias ? task[alias] : undefined) ??
    fields[key] ??
    fields[lower] ??
    fields[snake]
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
  // Arrays (labels, assignees) → membership semantics.
  if (Array.isArray(raw)) {
    const list = raw.map(String)
    if (op.startsWith('$ne:')) return !list.includes(op.slice(4))
    return list.includes(op)
  }
  const value = raw == null ? '' : String(raw)
  if (op.startsWith('$ne:')) return value !== op.slice(4)
  return value === op
}

export function evalWhen(task: Record<string, unknown>, when: unknown): boolean {
  if (!when) return true

  // legacy Record format → all-AND
  if (!Array.isArray(when)) {
    return Object.entries(when as Record<string, string>).every(([key, op]) =>
      evalCondition(task, key, op),
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

  return groups.some((group) => group.every((c) => evalCondition(task, c.field, condToOp(c))))
}
