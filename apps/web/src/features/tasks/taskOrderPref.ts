// La preferencia de VISTA que deja la acción `reorder` del asistente —
// SIEMPRE client-side, NUNCA se manda al server, y NUNCA toca el orden real
// que calcula `GetTaskDispositionsUseCase` (ver #215/#216). Puro y sin
// dependencia de Vue: se testea sin montar nada.
//
// Alcance deliberado: sólo se aplica al modo de orden "fuente" (la lista
// plana sin agrupar) — reordenar dentro de los buckets de "disposición" o
// del modo "repo" pisaría un criterio de orden que ya tiene su propia lógica
// congelada (`useDispositionOrder`), y tocar esa pieza para intercalar una
// preferencia más está fuera de alcance de este cambio.

function storageKey(projectId: string): string {
  return `ia-flow:taskOrderPref:${projectId}`
}

export function getTaskOrderPref(projectId: string): string[] | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((v) => typeof v === 'string') ? parsed : null
  } catch {
    return null
  }
}

export function setTaskOrderPref(projectId: string, taskIds: string[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(taskIds))
  } catch {
    /* preferencia de vista — no es estado que haya que garantizar */
  }
}

export function clearTaskOrderPref(projectId: string): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(storageKey(projectId))
  } catch {
    /* idem */
  }
}

/**
 * Aplica la preferencia guardada a una lista de ids ya calculada — las
 * conocidas van primero, en el orden guardado; el resto (tareas nuevas desde
 * que se guardó la preferencia) va al final, en su orden original.
 */
export function applyTaskOrderPref<T extends { id: string }>(
  items: T[],
  pref: string[] | null,
): T[] {
  if (!pref?.length) return items
  const byId = new Map(items.map((item) => [item.id, item]))
  const ordered: T[] = []
  for (const id of pref) {
    const item = byId.get(id)
    if (item) {
      ordered.push(item)
      byId.delete(id)
    }
  }
  for (const item of items) {
    if (byId.has(item.id)) ordered.push(item)
  }
  return ordered
}
