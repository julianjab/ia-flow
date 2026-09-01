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

function pr(state: PullRequestRef['state'], over: Partial<PullRequestRef> = {}): PullRequestRef {
  return {
    number: 1,
    url: `https://github.com/acme/repo/pull/${over.number ?? 1}`,
    state,
    isDraft: false,
    ...over,
  }
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

describe('filterTasks — repo', () => {
  it('matchea contra cualquiera de los repos de la tarea, case-insensitive', () => {
    const single = task({ repos: 'ia-flow' })
    const multi = task({ repos: 'ia-flow, otro-repo' })
    const none = task({ repos: 'algo-mas' })
    const kept = filterTasks([single, multi, none], withFilters({ repos: ['OTRO-REPO'] }))
    expect(kept).toEqual([multi])
  })
})

describe('filterTasks — assigned', () => {
  it('matchea si el login está entre los assignees, case-insensitive', () => {
    const mine = task({ assignees: ['juli'] })
    const other = task({ assignees: ['pepe'] })
    const none = task()
    const kept = filterTasks([mine, other, none], withFilters({ assignees: ['JULI'] }))
    expect(kept).toEqual([mine])
  })
})

describe('filterTasks — pr_status', () => {
  const merged = task({ status: 'done', pullRequests: [pr('merged')] })
  const open = task({ status: 'doing', pullRequests: [pr('open', { number: 2 })] })
  const draft = task({ status: 'doing', pullRequests: [pr('open', { number: 3, isDraft: true })] })
  const closed = task({ status: 'doing', pullRequests: [pr('closed', { number: 4 })] })
  const none = task({ status: 'refine' })

  it('vacío no filtra nada', () => {
    expect(
      filterTasks([merged, open, draft, closed, none], withFilters({ prStatus: [] })),
    ).toHaveLength(5)
  })

  it('cada valor filtra su propio estado', () => {
    expect(
      filterTasks([merged, open, draft, closed, none], withFilters({ prStatus: ['mergeado'] })),
    ).toEqual([merged])
    expect(
      filterTasks([merged, open, draft, closed, none], withFilters({ prStatus: ['abierto'] })),
    ).toEqual([open])
    expect(
      filterTasks([merged, open, draft, closed, none], withFilters({ prStatus: ['draft'] })),
    ).toEqual([draft])
    expect(
      filterTasks([merged, open, draft, closed, none], withFilters({ prStatus: ['cerrado'] })),
    ).toEqual([closed])
    expect(
      filterTasks([merged, open, draft, closed, none], withFilters({ prStatus: ['sin-pr'] })),
    ).toEqual([none])
  })

  it('dos valores del mismo eje son OR', () => {
    const kept = filterTasks(
      [merged, open, draft, closed, none],
      withFilters({ prStatus: ['mergeado', 'abierto'] }),
    )
    expect(kept).toEqual([merged, open])
  })
})

describe('filterTasks — branch', () => {
  it('"con-branch" pide branch linkeada', () => {
    const conBranch = task({ branch: 'task/42' })
    const sinBranch = task()
    expect(filterTasks([conBranch, sinBranch], withFilters({ branch: ['con-branch'] }))).toEqual([
      conBranch,
    ])
  })

  it('"sin-branch" es el complemento', () => {
    const conBranch = task({ branch: 'task/42' })
    const sinBranch = task()
    expect(filterTasks([conBranch, sinBranch], withFilters({ branch: ['sin-branch'] }))).toEqual([
      sinBranch,
    ])
  })

  it('los ejes componen en AND', () => {
    const all = [
      task({ status: 'refine', branch: 'task/1' }),
      task({ status: 'doing' }),
      task({ status: 'done', branch: 'task/3' }),
    ]
    const kept = filterTasks(
      all,
      withFilters({ statuses: ['refine', 'doing'], branch: ['con-branch'] }),
    )
    expect(kept).toEqual([all[0]])
  })
})

describe('filterTasks — providers que no hablan de PRs', () => {
  const unknown = task({ pullRequestsKnown: false })

  it('no cuenta como ningún pr_status, ni siquiera "sin-pr"', () => {
    expect(filterTasks([unknown], withFilters({ prStatus: ['sin-pr'] }))).toEqual([])
    expect(filterTasks([unknown], withFilters({ prStatus: ['mergeado'] }))).toEqual([])
  })

  it('con el filtro apagado sigue apareciendo — un "no sé" no es un "no tiene"', () => {
    expect(filterTasks([unknown], EMPTY_TASK_FILTERS)).toEqual([unknown])
  })
})

describe('serialización', () => {
  it('una vista sin filtros deja la query limpia', () => {
    expect(taskFiltersToQuery(EMPTY_TASK_FILTERS)).toEqual({})
    expect(hasActiveTaskFilters(EMPTY_TASK_FILTERS)).toBe(false)
    expect(queryHasTaskFilters({})).toBe(false)
  })

  it('ida y vuelta por el querystring preserva la selección', () => {
    const filters = withFilters({
      statuses: ['refine', 'doing'],
      repos: ['ia-flow'],
      assignees: ['juli'],
      branch: ['con-branch'],
      prStatus: ['abierto'],
    })
    expect(taskFiltersFromSearch(taskFiltersToSearch(filters))).toEqual(filters)
  })

  it('lee la query tal como la entrega vue-router (repetida o simple)', () => {
    expect(
      taskFiltersFromQuery({ status: ['refine', 'doing'], pr: 'mergeado', repo: 'ia-flow' }),
    ).toEqual(
      withFilters({ statuses: ['refine', 'doing'], prStatus: ['mergeado'], repos: ['ia-flow'] }),
    )
    expect(taskFiltersFromQuery({ status: 'refine' })).toEqual(
      withFilters({ statuses: ['refine'] }),
    )
  })

  it('un `pr`/`rama` desconocido se descarta en vez de filtrar por basura', () => {
    expect(taskFiltersFromQuery({ pr: 'quizas' }).prStatus).toEqual([])
    expect(taskFiltersFromQuery({ rama: 'quizas' }).branch).toEqual([])
  })
})
