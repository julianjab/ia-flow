import type { ITaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { createLogger } from './logger.js'

const log = createLogger('outcomes')

// El evaluador puro del DSL `when` (evalWhen/condToOp) vive en @ia-flow/shared —
// packages/issue-sources también lo necesita (filtro de proyecto pre-dispatch) y no
// puede depender de agent-engine. Re-exportado acá para no tocar los imports
// existentes (agent-selection.ts hace `import { evalWhen } from './outcomes.js'`).
export { condToOp, evalWhen } from '@ia-flow/shared'

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
