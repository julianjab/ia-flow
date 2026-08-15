import type { Task } from '@ia-flow/shared'

// Maps a source-native field name (as it appears in the upstream project,
// e.g. GitHub Project column "Status" / "Task Type" / "Repos") to the
// canonical Task property it should overwrite. Case-insensitive.
const CANONICAL_FIELD_MAP: Record<string, keyof Task> = {
  status: 'status',
  'task type': 'type',
  type: 'type',
  repos: 'repos',
}

/**
 * Merges a `setFields` write back into the in-memory `Task` shape without
 * losing the canonical properties the domain relies on (status, type, repos).
 *
 * Before this helper, `{ ...task, ...fields }` was used directly. That worked
 * only when the caller happened to key `fields` with the canonical lowercase
 * property name (e.g. `status`), and silently no-op'd on the canonical field
 * whenever the caller used the source-native name (e.g. `Status`). Any guard
 * that then compared `task.status` to a snapshot would read a stale value
 * and, in the case of the refiner, clobber the intentional Blocked with the
 * default `onFinish=Refined`.
 *
 * Always mirror the raw write into `task.fields` too, so `evalCondition`
 * lookups against source-native names keep working.
 */
export function mergeSourceFieldsIntoTask(task: Task, fields: Record<string, string>): Task {
  const patch: Partial<Task> = {}
  const extraFields: Record<string, string> = { ...(task.fields ?? {}) }
  for (const [rawName, rawValue] of Object.entries(fields)) {
    extraFields[rawName] = rawValue
    const key = CANONICAL_FIELD_MAP[rawName.toLowerCase()]
    if (!key) continue
    if (key === 'repos') {
      const list = rawValue
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean)
      ;(patch as Record<string, unknown>).repos = list
    } else if (key === 'type') {
      ;(patch as Record<string, unknown>).type = rawValue.toLowerCase()
    } else {
      ;(patch as Record<string, unknown>)[key] = rawValue
    }
  }
  return { ...task, ...patch, fields: extraFields }
}
