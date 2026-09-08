import type { TaskGroups } from '@ia-flow/shared'

/**
 * Corta las filas ya ordenadas (y CONGELADAS, ver `useDispositionOrder`) en
 * secciones: los grupos que trajo `/api/tasks/groups`, y lo suelto entre
 * medio.
 *
 * No reordena nada — sólo lee `rows` en el orden que ya trae. La primera vez
 * que aparece un id de un grupo, ese grupo entero se dibuja ahí (en el orden
 * relativo que sus miembros ya tenían), y el resto de sus ids se saltea más
 * adelante. Con `groups: null` (apagado, sin credencial, lista chica) todo cae
 * en una sola sección suelta — el flat list de siempre.
 */
export type GroupedSection<T> =
  | { kind: 'group'; label: string; rows: T[] }
  | { kind: 'loose'; rows: T[] }

/** El label de cada tarea agrupada, por id. Una tarea en dos grupos ya no
 *  puede llegar acá (el server dedupea), pero por las dudas gana el primero. */
function labelById(groups: TaskGroups['groups']): Map<string, string> {
  const out = new Map<string, string>()
  for (const g of groups) {
    for (const id of g.taskIds) if (!out.has(id)) out.set(id, g.label)
  }
  return out
}

export function sectionRows<T extends { id: string }>(
  rows: T[],
  groups: TaskGroups | null,
): GroupedSection<T>[] {
  if (!groups?.groups.length) {
    return rows.length ? [{ kind: 'loose', rows }] : []
  }

  const groupOf = labelById(groups.groups)
  const rendered = new Set<string>()
  const sections: GroupedSection<T>[] = []
  let loose: T[] = []

  for (const row of rows) {
    if (rendered.has(row.id)) continue
    const label = groupOf.get(row.id)
    if (!label) {
      loose.push(row)
      continue
    }
    if (loose.length) {
      sections.push({ kind: 'loose', rows: loose })
      loose = []
    }
    const members = rows.filter((r) => groupOf.get(r.id) === label && !rendered.has(r.id))
    for (const m of members) rendered.add(m.id)
    sections.push({ kind: 'group', label, rows: members })
  }
  if (loose.length) sections.push({ kind: 'loose', rows: loose })

  return sections
}
