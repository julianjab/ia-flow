// Lo que «Buscar en GitHub» necesita saber del board del runner, sin depender de la bandeja (otra
// feature): la view se lo pasa ya armado. Qué tarea es un resultado, en qué proyectos puede entrar
// un issue y en qué columnas. Puro.

/** Una tarea del board: su ref y su columna («» si no se sabe en cuál). */
export interface BoardEntry {
  ref: string
  status: string
}

/** Un proyecto del runner: sus columnas y su catálogo de repos (`owner/repo`). */
export interface BoardProject {
  id: string
  statuses?: readonly string[]
  repos?: readonly string[]
}

export interface AddRequest {
  issue: string
  project_id: string
  status?: string
}

/** Cómo terminó agregar al board: la columna en la que quedó, o por qué no. */
export type AddOutcome = { ok: true; status: string } | { ok: false; message: string }

/** La tarea del board de un resultado (el issue, o la tarea que abrió ese PR), o `null`. */
export function boardEntryOf(
  board: ReadonlyMap<string, BoardEntry>,
  ref: string,
): BoardEntry | null {
  return board.get(ref.toLowerCase()) ?? null
}

/** Los proyectos donde puede entrar un issue: los que tienen su repo en el catálogo; si ninguno
 *  lo declara (o el runner no manda catálogos), todos. */
export function addTargets(projects: readonly BoardProject[], ref: string): BoardProject[] {
  const repo = /^([^#]+)#\d+$/.exec(ref)?.[1]?.toLowerCase()
  const owning = projects.filter((p) => p.repos?.some((r) => r.toLowerCase() === repo))
  return owning.length ? owning : [...projects]
}

/** La columna en la que entra un issue nuevo: la de Todo si existe; si no, la primera. */
export function defaultColumn(statuses: readonly string[] | undefined): string | undefined {
  return statuses?.find((s) => s.trim().toLowerCase() === 'todo') ?? statuses?.[0]
}

/** Las columnas a elegir: la de entrada primero, «(por defecto)»; después el resto en su orden. */
export function columnOptions(
  statuses: readonly string[] | undefined,
): { status: string | undefined; label: string }[] {
  const first = defaultColumn(statuses)
  if (!first) return [{ status: undefined, label: 'Todo (por defecto)' }]
  return [
    { status: first, label: `${first} (por defecto)` },
    ...(statuses ?? []).filter((s) => s !== first).map((s) => ({ status: s, label: s })),
  ]
}
