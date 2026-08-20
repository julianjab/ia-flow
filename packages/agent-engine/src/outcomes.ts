import type { ITaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { createLogger } from './logger.js'

const log = createLogger('outcomes')

// El evaluador puro del DSL `when` (evalWhen/condToOp) vive en @ia-flow/issue-sources —
// packages/issue-sources también lo necesita (filtro de proyecto pre-dispatch) y
// agent-engine ya depende de issue-sources, no al revés. Re-exportado acá para no
// tocar los imports existentes (agent-selection.ts hace
// `import { evalWhen } from './outcomes.js'`).
export { condToOp, evalWhen } from '@ia-flow/issue-sources'

export interface FieldAssignment {
  field: string
  value: string
}

/**
 * Parsea el cuerpo de un `$set:` en asignaciones campo→valor, en orden.
 *
 * El separador de pares es `,` y el de campo/valor el PRIMER `=`. Un token
 * sin `=` NO se descarta: es la continuación del valor del par anterior. Esa
 * regla es la que permite que un campo multi-valor viaje entero
 * (`Labels=+agent:review,-agent:build`); sin ella se perdía todo menos el
 * primer token, que es justamente por lo que las labels tenían un canal
 * aparte (`$labels:` + `onXLabels`) antes de unificarse acá. Como efecto
 * lateral, un valor con comas en un campo simple (`Repos=api,web`) también
 * sobrevive, cosa que antes tampoco pasaba.
 *
 * Una clave repetida (`Labels=+a,Labels=-b`) acumula en vez de pisar, así el
 * editor de outcomes puede emitir una fila por operación sin perder ninguna.
 */
export function parseFieldAssignments(body: string): FieldAssignment[] {
  const pairs: FieldAssignment[] = []
  for (const token of body.split(',')) {
    const eq = token.indexOf('=')
    if (eq < 0) {
      // Continuación del valor anterior. Sin par previo no hay a qué
      // adjuntarla — se ignora (un `$set:` que arranca sin `=` está mal escrito).
      const last = pairs[pairs.length - 1]
      const cont = token.trim()
      if (last && cont) last.value = last.value ? `${last.value},${cont}` : cont
      continue
    }
    const field = token.slice(0, eq).trim()
    const value = token.slice(eq + 1).trim()
    if (!field) continue
    const existing = pairs.find((p) => p.field.toLowerCase() === field.toLowerCase())
    if (existing) existing.value = existing.value ? `${existing.value},${value}` : value
    else pairs.push({ field, value })
  }
  return pairs
}

/**
 * Aplica un outcome a la task vía el source.
 *
 * Formas soportadas:
 *   · "SomeStatus"                    → applyTransition(task, "SomeStatus")
 *                                       (forma corta de `$set:status=SomeStatus`)
 *   · "$set:field=value,f2=v2"        → setFields(task, {...}); `status` se
 *                                       enruta a applyTransition.
 *
 * Un campo multi-valor (`Labels`) viaja como tokens con signo
 * (`+añadir,-quitar,=reemplazar`) dentro de su `value`: acá NO se resuelven —
 * se pasan tal cual a `setFields`, y cada source los aplica contra el valor
 * actual del campo según su propia definición (ver `applyMultiValueOps` en
 * @ia-flow/issue-sources). Es el source el que sabe qué campos son
 * multi-valor y qué bookkeeping propio hay que blindar al escribirlos.
 */
export async function applyOutcome(
  task: Task,
  outcome: string,
  manager: ITaskSource,
): Promise<Task> {
  if (!outcome.startsWith('$set:')) {
    return manager.applyTransition(task, outcome)
  }

  const assignments = parseFieldAssignments(outcome.slice(5))
  const extraFields: Record<string, string> = {}
  for (const { field, value } of assignments) {
    if (field.toLowerCase() === 'status') {
      task = await manager.applyTransition(task, value)
    } else {
      extraFields[field] = value
    }
  }
  if (Object.keys(extraFields).length > 0) {
    if (manager.setFields) {
      task = await manager.setFields(task, extraFields)
    } else {
      log.warn(
        { taskId: task.id, outcome },
        'El source no soporta setFields — outcome aplicado sólo en memoria',
      )
      task = { ...task, ...extraFields } as Task
    }
  }
  return task
}
