import type { PullRequestRef } from '@ia-flow/shared'

// Filtros del listado de tareas. Todo lo que decide qué fila sobrevive vive
// acá y es puro: la barra sólo emite el estado y `TareasSection` lo aplica,
// así que los criterios se testean sin montar nada.
//
// Criterio común, el mismo que usan los caps del engine y la selección de
// agentes: **vacío = sin restricción**. Un eje sin selección no filtra nada,
// nunca "no matchea nada". Dentro de un eje multi-valor los valores son OR
// (mismo criterio que "resultado" en Ejecuciones/Logs); entre ejes es AND.

/** Estado del/de los PR de la tarea. `sin-pr` sólo lo afirma un provider que
 *  SABE hablar de PRs — ver `pullRequestsKnown`. */
export type PrStatusValue = 'abierto' | 'draft' | 'mergeado' | 'cerrado' | 'sin-pr'
export const PR_STATUS_VALUES: PrStatusValue[] = [
  'abierto',
  'draft',
  'mergeado',
  'cerrado',
  'sin-pr',
]

export type BranchValue = 'con-branch' | 'sin-branch'
export const BRANCH_VALUES: BranchValue[] = ['con-branch', 'sin-branch']

export interface TaskFilters {
  /** Statuses aceptados. Vacío ⇒ cualquiera. Se comparan case-insensitive. */
  statuses: string[]
  /** Repos aceptados (`task.repos` puede traer más de uno). Vacío ⇒ cualquiera. */
  repos: string[]
  /** Logins aceptados. Vacío ⇒ cualquiera. */
  assignees: string[]
  prStatus: PrStatusValue[]
  branch: BranchValue[]
}

/** Los campos del `TaskRow` que alimentan los predicados — nada más. */
export interface FilterableTask {
  status: string
  repos?: string
  assignees?: string[]
  branch?: string
  pullRequests: PullRequestRef[]
  /** false ⇒ el provider no sabe de PRs; no afirmamos ni "tiene" ni "no tiene". */
  pullRequestsKnown: boolean
}

export const EMPTY_TASK_FILTERS: TaskFilters = {
  statuses: [],
  repos: [],
  assignees: [],
  prStatus: [],
  branch: [],
}

export function hasActiveTaskFilters(f: TaskFilters): boolean {
  return (
    f.statuses.length > 0 ||
    f.repos.length > 0 ||
    f.assignees.length > 0 ||
    f.prStatus.length > 0 ||
    f.branch.length > 0
  )
}

/** `task.repos` es un string que puede traer más de uno (épicas multi-repo). */
function taskRepos(task: FilterableTask): string[] {
  return (task.repos ?? '').split(/[,\s]+/).filter(Boolean)
}

const PR_STATUS_PREDICATES: Record<PrStatusValue, (task: FilterableTask) => boolean> = {
  mergeado: (t) => t.pullRequestsKnown && t.pullRequests.some((pr) => pr.state === 'merged'),
  cerrado: (t) => t.pullRequestsKnown && t.pullRequests.some((pr) => pr.state === 'closed'),
  abierto: (t) =>
    t.pullRequestsKnown && t.pullRequests.some((pr) => pr.state === 'open' && !pr.isDraft),
  draft: (t) =>
    t.pullRequestsKnown && t.pullRequests.some((pr) => pr.state === 'open' && pr.isDraft),
  'sin-pr': (t) => t.pullRequestsKnown && t.pullRequests.length === 0,
}

/** Aplica todos los ejes en AND; dentro de `prStatus`/`branch` los valores son OR. */
export function filterTasks<T extends FilterableTask>(tasks: T[], f: TaskFilters): T[] {
  const wantedStatus = new Set(f.statuses.map((s) => s.toLowerCase()))
  const wantedRepos = new Set(f.repos.map((r) => r.toLowerCase()))
  const wantedAssignees = new Set(f.assignees.map((a) => a.toLowerCase()))
  return tasks.filter((task) => {
    if (wantedStatus.size > 0 && !wantedStatus.has((task.status ?? '').toLowerCase())) return false
    if (wantedRepos.size > 0 && !taskRepos(task).some((r) => wantedRepos.has(r.toLowerCase())))
      return false
    if (
      wantedAssignees.size > 0 &&
      !(task.assignees ?? []).some((a) => wantedAssignees.has(a.toLowerCase()))
    )
      return false
    if (f.prStatus.length > 0 && !f.prStatus.some((v) => PR_STATUS_PREDICATES[v](task)))
      return false
    if (
      f.branch.length > 0 &&
      !f.branch.some((v) => (v === 'con-branch' ? !!task.branch : !task.branch))
    )
      return false
    return true
  })
}

// ─── Serialización ───────────────────────────────────────────────────────
// La ruta activa ya es `projects/:id/tareas`, así que el querystring nace
// scopeado por proyecto sin prefijar nada. Ese mismo string es el que se
// guarda en localStorage para las entradas en frío (sin query en la URL).

/** Forma en la que vue-router entrega `route.query`. */
export type QueryRecord = Record<string, string | (string | null)[] | null | undefined>

function queryStrArr(query: QueryRecord, key: string): string[] {
  const raw = query[key]
  if (typeof raw === 'string') return raw ? [raw] : []
  if (Array.isArray(raw))
    return raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return []
}

export function taskFiltersFromQuery(query: QueryRecord): TaskFilters {
  return {
    statuses: queryStrArr(query, 'status'),
    repos: queryStrArr(query, 'repo'),
    assignees: queryStrArr(query, 'assigned'),
    prStatus: queryStrArr(query, 'pr').filter((v): v is PrStatusValue =>
      PR_STATUS_VALUES.includes(v as PrStatusValue),
    ),
    branch: queryStrArr(query, 'rama').filter((v): v is BranchValue =>
      BRANCH_VALUES.includes(v as BranchValue),
    ),
  }
}

/** Sólo emite las claves activas: una vista sin filtros deja la URL limpia. */
export function taskFiltersToQuery(f: TaskFilters): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  if (f.statuses.length > 0) query.status = [...f.statuses]
  if (f.repos.length > 0) query.repo = [...f.repos]
  if (f.assignees.length > 0) query.assigned = [...f.assignees]
  if (f.prStatus.length > 0) query.pr = [...f.prStatus]
  if (f.branch.length > 0) query.rama = [...f.branch]
  return query
}

export function queryHasTaskFilters(query: QueryRecord): boolean {
  return hasActiveTaskFilters(taskFiltersFromQuery(query))
}

export function taskFiltersToSearch(f: TaskFilters): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(taskFiltersToQuery(f))) {
    if (Array.isArray(value)) for (const v of value) params.append(key, v)
    else params.set(key, value)
  }
  return params.toString()
}

export function taskFiltersFromSearch(search: string): TaskFilters {
  const params = new URLSearchParams(search)
  const query: QueryRecord = {}
  for (const key of new Set(params.keys())) query[key] = params.getAll(key)
  return taskFiltersFromQuery(query)
}
