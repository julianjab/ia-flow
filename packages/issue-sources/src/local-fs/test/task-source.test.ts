import { describe, expect, test } from 'bun:test'
import type { Task } from '@ia-flow/shared'
import type { ITaskRepository } from '../../contract.js'
import { LocalTaskSource } from '../task-source.js'

// El source local es la contraparte "sin API" del de GitHub: las labels no
// viven en un issue remoto sino en la propia task, así que la prueba de que
// un outcome `$set:Labels=+a,-b` funciona acá es que el array quede resuelto
// Y persistido por el repo — no alcanza con devolver la task mutada en
// memoria, porque el próximo scan la relee del disco.

const TASK: Task = {
  id: 'local-1',
  title: 'Do the thing',
  description: 'body',
  type: 'functional',
  repos: ['ia-flow'],
  status: 'queued',
  created_at: '2024-01-01T00:00:00Z',
  labels: ['agent:build', 'bug'],
}

function fakeRepo(): { repo: ITaskRepository; saved: Task[] } {
  const saved: Task[] = []
  const repo = {
    root: () => '/tmp/tasks',
    read: async () => null,
    save: async () => {},
    listAll: async () => [],
    getById: async () => null,
    move: async (task: Task, newStatus: string) => ({ ...task, status: newStatus }) as Task,
    update: async (task: Task) => {
      saved.push(task)
    },
    delete: async () => {},
    listStatuses: async () => [],
  } as ITaskRepository
  return { repo, saved }
}

describe('LocalTaskSource.setFields — campo multi-valor Labels', () => {
  test('resuelve los tokens con signo contra las labels vigentes y persiste', async () => {
    const { repo, saved } = fakeRepo()

    const updated = await new LocalTaskSource(repo).setFields(TASK, {
      Labels: '+agent:review,-agent:build',
    })

    expect(updated.labels).toEqual(['bug', 'agent:review'])
    expect(saved).toHaveLength(1)
    expect(saved[0]?.labels).toEqual(['bug', 'agent:review'])
  })

  test('un = reemplaza el set completo', async () => {
    const { repo, saved } = fakeRepo()

    const updated = await new LocalTaskSource(repo).setFields(TASK, { Labels: '=solo-esta' })

    expect(updated.labels).toEqual(['solo-esta'])
    expect(saved[0]?.labels).toEqual(['solo-esta'])
  })

  test('un = pelado vacía el campo', async () => {
    const { repo, saved } = fakeRepo()

    const updated = await new LocalTaskSource(repo).setFields(TASK, { Labels: '=' })

    expect(updated.labels).toEqual([])
    expect(saved[0]?.labels).toEqual([])
  })

  test('el spec no se filtra a task.fields — es una operación, no un valor', async () => {
    const { repo } = fakeRepo()

    const updated = await new LocalTaskSource(repo).setFields(TASK, { Labels: '+x' })

    expect(updated.fields?.Labels).toBeUndefined()
  })

  test('un campo de un solo valor convive con las labels en el mismo setFields', async () => {
    const { repo, saved } = fakeRepo()

    const updated = await new LocalTaskSource(repo).setFields(TASK, {
      Priority: 'high',
      Labels: '+agent:review',
    })

    expect(updated.fields?.Priority).toBe('high')
    expect(updated.labels).toEqual(['agent:build', 'bug', 'agent:review'])
    expect(saved).toHaveLength(1)
  })

  test('sin ops de labels, las que ya estaban quedan intactas', async () => {
    const { repo, saved } = fakeRepo()

    const updated = await new LocalTaskSource(repo).setFields(TASK, { Priority: 'low' })

    expect(updated.labels).toEqual(['agent:build', 'bug'])
    expect(saved[0]?.labels).toEqual(['agent:build', 'bug'])
  })
})
