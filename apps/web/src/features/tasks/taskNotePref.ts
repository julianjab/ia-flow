// Las notas que el asistente deja sobre una tarea (acción `note`) — SIEMPRE
// client-side, NUNCA se mandan al server. Antes viajaban a
// `POST /api/tasks/assistant/notes` (una tabla + repo creados sólo para
// esto); se reemplaza por `localStorage`, mismo patrón que `taskOrderPref.ts`
// y `taskTagPref.ts`.

export interface TaskNotePrefEntry {
  text: string
  createdAt: string
}

function storageKey(projectId: string): string {
  return `ia-flow:taskNotePref:${projectId}`
}

function readAll(projectId: string): Record<string, TaskNotePrefEntry[]> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, TaskNotePrefEntry[]>)
      : {}
  } catch {
    return {}
  }
}

function writeAll(projectId: string, byTask: Record<string, TaskNotePrefEntry[]>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(byTask))
  } catch {
    /* preferencia de vista — no es estado que haya que garantizar */
  }
}

export function getTaskNotePref(projectId: string, taskId: string): TaskNotePrefEntry[] {
  return readAll(projectId)[taskId] ?? []
}

export function addTaskNotePref(projectId: string, taskId: string, text: string): void {
  const byTask = readAll(projectId)
  byTask[taskId] = [...(byTask[taskId] ?? []), { text, createdAt: new Date().toISOString() }]
  writeAll(projectId, byTask)
}
