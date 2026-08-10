import type { Task } from '@ia-flow/shared'
import type { ITransitionManager } from '../domain/ports/ITransitionManager.js'

// GitHub Project field names differ from Task object keys — map the common ones.
const FIELD_ALIASES: Record<string, string> = {
  'task type': 'type',
  task_type: 'type',
}

/**
 * Applies an outcome string to a task via the manager.
 *
 * Supported forms:
 *   · "SomeStatus"                 → applyTransition(task, "SomeStatus")
 *   · "$set:field=value,f2=v2"     → setFields(task, {...}), status also
 *                                    handled by applyTransition when set.
 */
export async function applyOutcome(
  task: Task,
  outcome: string,
  manager: ITransitionManager,
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
  const raw = task[key] ?? task[lower] ?? task[snake] ?? (alias ? task[alias] : undefined)
  const value = raw == null ? '' : Array.isArray(raw) ? raw.join(', ') : String(raw)
  if (op === '$null') return value === ''
  if (op === '$not_null') return value !== ''
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
