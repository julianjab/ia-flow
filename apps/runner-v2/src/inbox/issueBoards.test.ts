import { describe, expect, it } from 'bun:test'
import { issueBoards, placement } from './issueBoards.js'

const resolve = issueBoards({
  projects: [{ projectId: 'p', repos: ['la-haus/subscriptions'] }],
  statuses: async () => ['Todo', 'Refine', 'Done'],
  labelBoards: {
    'julianjab/ia-flow': { Todo: 'status:todo', Refine: 'status:refine' },
    'la-haus/subscriptions': { Todo: 'status:todo' },
  },
})

describe('the board an improvement issue goes to', () => {
  it('a repo of a project goes to its board, before any label board', async () => {
    expect(await resolve('la-haus/subscriptions')).toEqual({
      kind: 'project',
      project_id: 'p',
      columns: ['Todo', 'Refine', 'Done'],
    })
  })

  it('a repo another runner reads by labels offers its columns in order', async () => {
    expect(await resolve('julianjab/ia-flow')).toMatchObject({
      kind: 'labels',
      columns: ['Todo', 'Refine'],
    })
  })

  it('a repo of neither has no board', async () => {
    expect(await resolve('otra/cosa')).toBeUndefined()
  })

  it('a project whose board cannot be read offers no columns', async () => {
    const broken = issueBoards({
      projects: [{ projectId: 'p', repos: ['o/r'] }],
      statuses: async () => {
        throw new Error('sin red')
      },
      labelBoards: {},
    })
    expect(await broken('o/r')).toEqual({ kind: 'project', project_id: 'p', columns: [] })
  })
})

describe('where the issue lands', () => {
  const labels = {
    kind: 'labels' as const,
    columns: ['Todo', 'Refine'],
    labels: { Todo: 'status:todo', Refine: 'status:refine' },
  }

  it('by labels, the chosen column is its label; without one, the first', () => {
    expect(placement(labels, 'Refine')).toEqual({ status: 'Refine', label: 'status:refine' })
    expect(placement(labels, undefined)).toEqual({ status: 'Todo', label: 'status:todo' })
  })

  it('in a project board, the column goes to the board; without one, it decides', () => {
    const project = { kind: 'project' as const, project_id: 'p', columns: ['Todo', 'Refine'] }
    expect(placement(project, 'Refine')).toEqual({ status: 'Refine' })
    expect(placement(project, undefined)).toEqual({})
  })

  it('a column the board does not have is refused', () => {
    expect(() => placement(labels, 'Done')).toThrow('"Done" no es una columna: Todo, Refine')
  })
})
