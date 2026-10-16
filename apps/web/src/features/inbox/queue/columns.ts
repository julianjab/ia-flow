// Las columnas del board de cada proyecto (`InboxProject.statuses`): a dónde se puede mover una
// card del feed y en cuál entra un issue que se agrega. Puro, sin Vue.

import type { InboxProject } from '@ia-flow/shared'

type Columns = Pick<InboxProject, 'id' | 'statuses'>

/** El proyecto de una card; sin `projectId`, el único que haya. */
export function projectOf<P extends Columns>(
  projects: readonly P[],
  projectId: string | undefined,
): P | undefined {
  if (projectId) return projects.find((p) => p.id === projectId)
  return projects.length === 1 ? projects[0] : undefined
}

/** A dónde se puede mover una card: las columnas de su proyecto menos la suya. Un runner que no
 *  manda las columnas no ofrece ninguna. */
export function moveTargets(
  projects: readonly Columns[],
  card: { projectId?: string; status?: string },
): string[] {
  const statuses = projectOf(projects, card.projectId)?.statuses ?? []
  const current = card.status?.toLowerCase()
  return statuses.filter((s) => s.toLowerCase() !== current)
}

/** La columna en la que entra un issue nuevo: la de Todo si existe; si no, la primera. */
export function defaultColumn(statuses: readonly string[] | undefined): string | undefined {
  return statuses?.find((s) => s.trim().toLowerCase() === 'todo') ?? statuses?.[0]
}

/** Los proyectos con sus columnas: si `/api/tasks` no las trae, las de `/api/inbox`. */
export function withColumns<P extends Columns>(
  projects: readonly P[],
  fallback: readonly Columns[],
): P[] {
  return projects.map((p) => {
    if (p.statuses?.length) return p
    const statuses = fallback.find((f) => f.id === p.id)?.statuses
    return statuses?.length ? { ...p, statuses } : p
  })
}
