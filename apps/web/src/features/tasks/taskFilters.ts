import type { PullRequestRef } from '@ia-flow/shared'

// Filtros del listado de tareas. Todo lo que decide qué fila sobrevive vive
// acá y es puro: la barra sólo emite el estado y `TareasSection` lo aplica,
// así que los criterios se testean sin montar nada.
//
// Criterio común, el mismo que usan los caps del engine y la selección de
// agentes: **vacío = sin restricción**. Un eje sin selección no filtra nada,
// nunca "no matchea nada".

/** Tri-estado del filtro de PR mergeado: apagado / sólo mergeadas / esconderlas. */
export type MergedFilter = 'off' | 'only' | 'hide'

export interface TaskFilters {
  /** Statuses aceptados. Vacío ⇒ cualquiera. Se comparan case-insensitive. */
  statuses: string[]
  /** Sólo tareas con al menos un PR conocido. */
  hasPr: boolean
  /** Sólo tareas con branch remota linkeada. */
  hasBranch: boolean
  merged: MergedFilter
}

/** Los campos del `TaskRow` que alimentan los predicados — nada más. */
export interface FilterableTask {
  status: string
  branch?: string
  pullRequests: PullRequestRef[]
  /** false ⇒ el provider no sabe de PRs; no afirmamos ni "tiene" ni "no tiene". */
  pullRequestsKnown: boolean
}

export const EMPTY_TASK_FILTERS: TaskFilters = {
  statuses: [],
  hasPr: false,
  hasBranch: false,
  merged: 'off',
}

export function hasActiveTaskFilters(f: TaskFilters): boolean {
  return f.statuses.length > 0 || f.hasPr || f.hasBranch || f.merged !== 'off'
}

/** Un PR mergeado sólo cuenta si el provider habla de PRs (ver `pullRequestsKnown`). */
function isMerged(task: FilterableTask): boolean {
  return task.pullRequestsKnown && task.pullRequests.some((pr) => pr.state === 'merged')
}

function hasPr(task: FilterableTask): boolean {
  return task.pullRequestsKnown && task.pullRequests.length > 0
}

/**
 * Aplica todos los ejes en AND. Los items con `pullRequestsKnown === false`
 * (local-fs y cualquier selección degradada) no satisfacen `hasPr` ni
 * `merged: 'only'` — no afirmamos lo que el provider no sabe. `merged: 'hide'`
 * en cambio los conserva: esconder lo que no podemos afirmar mergeado dejaría
 * esos proyectos con el listado vacío, que es peor que dejar una fila de más.
 */
export function filterTasks<T extends FilterableTask>(tasks: T[], f: TaskFilters): T[] {
  const wanted = new Set(f.statuses.map((s) => s.toLowerCase()))
  return tasks.filter((task) => {
    if (wanted.size > 0 && !wanted.has((task.status ?? '').toLowerCase())) return false
    if (f.hasPr && !hasPr(task)) return false
    if (f.hasBranch && !task.branch) return false
    if (f.merged === 'only' && !isMerged(task)) return false
    if (f.merged === 'hide' && isMerged(task)) return false
    return true
  })
}

// ─── Serialización ───────────────────────────────────────────────────────
// La ruta activa ya es `projects/:id/tareas`, así que el querystring nace
// scopeado por proyecto sin prefijar nada. Ese mismo string es el que se
// guarda en localStorage para las entradas en frío (sin query en la URL).

/** Forma en la que vue-router entrega `route.query`. */
export type QueryRecord = Record<string, string | (string | null)[] | null | undefined>

const MERGED_VALUES: MergedFilter[] = ['only', 'hide']

function queryStrArr(query: QueryRecord, key: string): string[] {
  const raw = query[key]
  if (typeof raw === 'string') return raw ? [raw] : []
  if (Array.isArray(raw))
    return raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return []
}

function queryFlag(query: QueryRecord, key: string): boolean {
  return queryStrArr(query, key)[0] === '1'
}

export function taskFiltersFromQuery(query: QueryRecord): TaskFilters {
  const merged = queryStrArr(query, 'merged')[0]
  return {
    statuses: queryStrArr(query, 'status'),
    hasPr: queryFlag(query, 'pr'),
    hasBranch: queryFlag(query, 'branch'),
    merged: MERGED_VALUES.includes(merged as MergedFilter) ? (merged as MergedFilter) : 'off',
  }
}

/** Sólo emite las claves activas: una vista sin filtros deja la URL limpia. */
export function taskFiltersToQuery(f: TaskFilters): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  if (f.statuses.length > 0) query.status = [...f.statuses]
  if (f.hasPr) query.pr = '1'
  if (f.hasBranch) query.branch = '1'
  if (f.merged !== 'off') query.merged = f.merged
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
