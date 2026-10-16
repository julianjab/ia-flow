import { describe, expect, it } from 'vitest'
import { defaultColumn, moveTargets, projectOf, withColumns } from '@/features/inbox/queue/columns'
import { runnerFeed } from '@/features/inbox/queue/runnerFeed'

const core = { id: 'core', statuses: ['Backlog', 'Todo', 'Refine', 'Build', 'Done'] }
const web = { id: 'web', statuses: ['Ready', 'Doing'] }

describe('las columnas del board', () => {
  it('a dónde se mueve una card: las de su proyecto menos la suya', () => {
    expect(moveTargets([core, web], { projectId: 'core', status: 'Todo' })).toEqual([
      'Backlog',
      'Refine',
      'Build',
      'Done',
    ])
    expect(moveTargets([core, web], { projectId: 'web', status: 'todo' })).toEqual([
      'Ready',
      'Doing',
    ])
  })

  it('sin columnas (runner viejo) o sin proyecto entre varios, no hay a dónde moverla', () => {
    expect(moveTargets([{ id: 'core' }], { projectId: 'core', status: 'Todo' })).toEqual([])
    expect(moveTargets([core, web], { status: 'Todo' })).toEqual([])
    expect(moveTargets([core], { status: 'Todo' })).toHaveLength(4)
  })

  it('projectOf: por id, o el único que haya', () => {
    expect(projectOf([core, web], 'web')).toBe(web)
    expect(projectOf([core], undefined)).toBe(core)
    expect(projectOf([core, web], undefined)).toBeUndefined()
  })

  it('un issue nuevo entra en Todo; si no hay Todo, en la primera', () => {
    expect(defaultColumn(core.statuses)).toBe('Todo')
    expect(defaultColumn(['Ready', 'TODO'])).toBe('TODO')
    expect(defaultColumn(web.statuses)).toBe('Ready')
    expect(defaultColumn([])).toBeUndefined()
    expect(defaultColumn(undefined)).toBeUndefined()
  })

  it('withColumns completa las columnas que /api/tasks no trae con las de /api/inbox', () => {
    const merged = withColumns([{ id: 'core' }, { id: 'web', statuses: ['A'] }], [core, web])
    expect(merged).toEqual([
      { id: 'core', statuses: core.statuses },
      { id: 'web', statuses: ['A'] },
    ])
  })

  it('el feed del runner trae el proyecto y la columna de cada card', () => {
    const card = {
      ref: 'acme/api#7',
      project_id: 'core',
      title: 'x',
      url: 'u',
      status: 'Todo',
      labels: [],
      updated_at: 'x',
    }
    const feed = runnerFeed({ ready: [card], waiting: [] })
    expect(feed?.entries[0]).toMatchObject({ projectId: 'core', status: 'Todo' })
  })
})
