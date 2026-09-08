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

export function sectionRows<T extends { id: string }>(
  rows: T[],
  groups: TaskGroups | null,
): GroupedSection<T>[] {
  if (!groups || !groups.groups.length) {
    return rows.length ? [{ kind: 'loose', rows }] : []
  }

  const groupOf = new Map<string, string>()
  for (const g of groups.groups) {
    for (const id of g.taskIds) if (!groupOf.has(id)) groupOf.set(id, g.label)
  }

  const sections: GroupedSection<T>[] = []
  const rendered = new Set<string>()
  let loose: T[] = []

  const flushLoose = () => {
    if (loose.length) sections.push({ kind: 'loose', rows: loose })
    loose = []
  }

  for (const row of rows) {
    if (rendered.has(row.id)) continue
    const label = groupOf.get(row.id)
    if (!label) {
      loose.push(row)
      continue
    }
    flushLoose()
    const members = rows.filter((r) => groupOf.get(r.id) === label && !rendered.has(r.id))
    for (const m of members) rendered.add(m.id)
    sections.push({ kind: 'group', label, rows: members })
  }
  flushLoose()

  return sections
}
