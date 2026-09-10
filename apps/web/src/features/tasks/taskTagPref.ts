// Los tags que propone y aplica el asistente — SIEMPRE client-side, NUNCA se
// mandan al server. Antes `tag` pisaba el campo `Labels` de GitHub Projects
// (`setProjectItemField`); eso escribía en un sistema real por una propuesta
// de IA sin revisión humana, así que ahora es una preferencia de vista, igual
// que `taskOrderPref.ts`.

function storageKey(projectId: string): string {
  return `ia-flow:taskTagPref:${projectId}`
}

function readAll(projectId: string): Record<string, string[]> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string[]> = {}
    for (const [taskId, tags] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(tags) && tags.every((t) => typeof t === 'string')) out[taskId] = tags
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(projectId: string, byTask: Record<string, string[]>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(byTask))
  } catch {
    /* preferencia de vista — no es estado que haya que garantizar */
  }
}

export function getTaskTagPref(projectId: string, taskId: string): string[] {
  return readAll(projectId)[taskId] ?? []
}

/** Suma tags nuevos a los que ya tenía la tarea — mismo comportamiento aditivo que el `+tag` de GitHub Labels. */
export function addTaskTagPref(projectId: string, taskId: string, tags: string[]): string[] {
  const byTask = readAll(projectId)
  const merged = Array.from(new Set([...(byTask[taskId] ?? []), ...tags]))
  byTask[taskId] = merged
  writeAll(projectId, byTask)
  return merged
}

export function clearTaskTagPref(projectId: string, taskId?: string): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (!taskId) {
      localStorage.removeItem(storageKey(projectId))
      return
    }
    const byTask = readAll(projectId)
    delete byTask[taskId]
    writeAll(projectId, byTask)
  } catch {
    /* idem */
  }
}
