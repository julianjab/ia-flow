import type { TaskGroupSet } from '@/features/tasks/task-grouping'

// Los grupos por tema que el Asistente propone y aplica (acción `group`) —
// SIEMPRE client-side, NUNCA se piden al server. Reemplaza al viejo cómputo
// de Haiku en `/api/tasks/groups`: ahora es el propio modelo del chat el que
// arma los grupos, con el mismo contexto de tareas que ya tiene para
// contestar preguntas — sin una llamada a IA aparte.

function storageKey(projectId: string): string {
  return `ia-flow:taskGroupPref:${projectId}`
}

export function getTaskGroupPref(projectId: string): TaskGroupSet | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isTaskGroupSet(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isTaskGroupSet(value: unknown): value is TaskGroupSet {
  if (!value || typeof value !== 'object' || !Array.isArray((value as TaskGroupSet).groups))
    return false
  return (value as TaskGroupSet).groups.every(
    (g) =>
      g &&
      typeof g.label === 'string' &&
      Array.isArray(g.taskIds) &&
      g.taskIds.every((id) => typeof id === 'string'),
  )
}

/** `groups` vacío borra la preferencia — es cómo el Asistente propone
 *  "desagrupar" (ver `TaskChatActionSchema`). */
export function setTaskGroupPref(projectId: string, groups: TaskGroupSet['groups']): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (!groups.length) {
      localStorage.removeItem(storageKey(projectId))
      return
    }
    localStorage.setItem(storageKey(projectId), JSON.stringify({ groups }))
  } catch {
    /* preferencia de vista — no es estado que haya que garantizar */
  }
}

export function clearTaskGroupPref(projectId: string): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(storageKey(projectId))
  } catch {
    /* idem */
  }
}
