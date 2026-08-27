import type { PullRequestRef } from '@ia-flow/shared'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_TASK_FILTERS,
  type FilterableTask,
  type TaskFilters,
  filterTasks,
  hasActiveTaskFilters,
  queryHasTaskFilters,
  taskFiltersFromQuery,
  taskFiltersFromSearch,
  taskFiltersToQuery,
  taskFiltersToSearch,
} from './taskFilters'

function pr(state: PullRequestRef['state'], number = 1): PullRequestRef {
  return { number, url: `https://github.com/acme/repo/pull/${number}`, state, isDraft: false }
}

function task(over: Partial<FilterableTask> = {}): FilterableTask {
  return { status: 'refine', pullRequests: [], pullRequestsKnown: true, ...over }
}

function withFilters(over: Partial<TaskFilters>): TaskFilters {
  return { ...EMPTY_TASK_FILTERS, ...over }
}

describe('filterTasks — vacío es "sin restricción"', () => {
  it('sin ningún filtro devuelve todo', () => {
    const all = [task(), task({ status: 'doing' })]
    expect(filterTasks(all, EMPTY_TASK_FILTERS)).toHaveLength(2)
  })

  it('deseleccionar todos los statuses no filtra nada (no es "no coincide nada")', () => {
    const all = [task({ status: 'refine' }), task({ status: 'done' })]
    expect(filterTasks(all, withFilters({ statuses: [] }))).toHaveLength(2)
  })
})

describe('filterTasks — status', () => {
  it('acepta cualquiera de los statuses seleccionados, case-insensitive', () => {
    const all = [task({ status: 'refine' }), task({ status: 'Doing' }), task({ status: 'done' })]
    const kept = filterTasks(all, withFilters({ statuses: ['REFINE', 'doing'] }))
    expect(kept.map((t) => t.status)).toEqual(['refine', 'Doing'])
  })
})

describe('filterTasks — mergeado (tri-estado)', () => {
  const merged = task({ status: 'done', pullRequests: [pr('merged')] })
  const open = task({ status: 'doing', pullRequests: [pr('open', 2)] })
  const none = task({ status: 'refine' })

  it('off no toca nada', () => {
    expect(filterTasks([merged, open, none], withFilters({ merged: 'off' }))).toHaveLength(3)
  })

  it('hide esconde las que ya tienen un PR mergeado', () => {
    expect(filterTasks([merged, open, none], withFilters({ merged: 'hide' }))).toEqual([open, none])
  })

  it('only deja únicamente las mergeadas', () => {
    expect(filterTasks([merged, open, none], withFilters({ merged: 'only' }))).toEqual([merged])
  })
})

describe('filterTasks — dev links', () => {
  it('"con PR" pide al menos un PR conocido', () => {
    const conPr = task({ pullRequests: [pr('open')] })
    const sinPr = task()
    expect(filterTasks([conPr, sinPr], withFilters({ hasPr: true }))).toEqual([conPr])
  })

  it('"con branch" pide branch linkeada', () => {
    const conBranch = task({ branch: 'task/42' })
    const sinBranch = task()
    expect(filterTasks([conBranch, sinBranch], withFilters({ hasBranch: true }))).toEqual([
      conBranch,
    ])
  })

  it('los ejes componen en AND', () => {
    const all = [
      task({ status: 'refine', branch: 'task/1' }),
      task({ status: 'doing' }),
      task({ status: 'done', branch: 'task/3' }),
    ]
    const kept = filterTasks(all, withFilters({ statuses: ['refine', 'doing'], hasBranch: true }))
    expect(kept).toEqual([all[0]])
  })
})

describe('filterTasks — providers que no hablan de PRs', () => {
  const unknown = task({ pullRequestsKnown: false })

  it('no cuenta como "con PR"', () => {
    expect(filterTasks([unknown], withFilters({ hasPr: true }))).toEqual([])
  })

  it('no cuenta como mergeada', () => {
    expect(filterTasks([unknown], withFilters({ merged: 'only' }))).toEqual([])
  })

  it('con el filtro apagado sigue apareciendo — un "no sé" no es un "no tiene"', () => {
    expect(filterTasks([unknown], EMPTY_TASK_FILTERS)).toEqual([unknown])
    expect(filterTasks([unknown], withFilters({ merged: 'hide' }))).toEqual([unknown])
  })
})

describe('serialización', () => {
  it('una vista sin filtros deja la query limpia', () => {
    expect(taskFiltersToQuery(EMPTY_TASK_FILTERS)).toEqual({})
    expect(hasActiveTaskFilters(EMPTY_TASK_FILTERS)).toBe(false)
    expect(queryHasTaskFilters({})).toBe(false)
  })

  it('ida y vuelta por el querystring preserva la selección', () => {
    const filters = withFilters({ statuses: ['refine', 'doing'], hasBranch: true, merged: 'hide' })
    expect(taskFiltersFromSearch(taskFiltersToSearch(filters))).toEqual(filters)
  })

  it('lee la query tal como la entrega vue-router (repetida o simple)', () => {
    expect(taskFiltersFromQuery({ status: ['refine', 'doing'], pr: '1', merged: 'only' })).toEqual(
      withFilters({ statuses: ['refine', 'doing'], hasPr: true, merged: 'only' }),
    )
    expect(taskFiltersFromQuery({ status: 'refine' })).toEqual(
      withFilters({ statuses: ['refine'] }),
    )
  })

  it('un `merged` desconocido cae a off en vez de filtrar por basura', () => {
    expect(taskFiltersFromQuery({ merged: 'quizas' }).merged).toBe('off')
  })
})
