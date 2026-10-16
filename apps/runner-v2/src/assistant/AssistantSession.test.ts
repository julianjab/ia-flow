import { describe, expect, it } from 'bun:test'
import type { InboxItem } from '@ia-flow/shared'
import { type AssistantBackend, AssistantSession } from './AssistantSession.js'

const merge: InboxItem = {
  ref: 'o/r#1',
  project_id: 'p',
  title: 'Mergear',
  url: 'u',
  group: 'need',
  kind: 'merge',
  labels: [],
  why: 'Review + reviewed',
  since: '2026-09-29T10:00:00Z',
  unlocks: 2,
  epic: { ref: 'o/r#9', title: 'Bandeja', done: 1, total: 4 },
  priority: 1,
  reasons: ['a un merge de Done', 'destraba 2 tareas'],
  actions: ['merge'],
}

const backend = {
  inbox: { inbox: async () => ({ items: [merge] }) },
} as unknown as AssistantBackend

describe('AssistantSession.listTasks', () => {
  it('each task says its place in the order, why, and how much it unblocks', async () => {
    const session = new AssistantSession({ kind: 'general' }, backend, () => {})
    const [first] = await session.listTasks()
    expect(first).toMatchObject({
      ref: 'o/r#1',
      priority: 1,
      reasons: ['a un merge de Done', 'destraba 2 tareas'],
      unlocks: 2,
    })
  })

  it('each task says its epic and how far along it is', async () => {
    const session = new AssistantSession({ kind: 'general' }, backend, () => {})
    const [first] = await session.listTasks()
    expect(first?.epic).toEqual({ ref: 'o/r#9', title: 'Bandeja', done: 1, total: 4 })
  })
})

describe('AssistantSession en el contexto de una tarea cerrada', () => {
  // Se pregunta por una mejora de la retrospectiva: la tarea ya salió del board con el merge.
  const executions = [{ id: 'e2', task_ref: 'o/r#5' }]
  const closed = {
    inbox: { item: async () => undefined, detail: async () => undefined },
    activity: {
      executions: () => executions,
      eventsForTask: () => [{ type: 'pull_request.closed' }],
      trace: () => [{ kind: 'log', name: 'propongo documentar los tests', attributes: {} }],
    },
  } as unknown as AssistantBackend

  it('get_task trae sus ejecuciones y la traza de la última', async () => {
    const session = new AssistantSession({ kind: 'task', ref: 'o/r#5' }, closed, () => {})
    const detail = await session.taskDetail('o/r#5')
    expect(detail.item).toMatchObject({ ref: 'o/r#5' })
    expect(detail.executions.map((execution) => execution.id)).toEqual(['e2'])
    expect(detail.trace).toHaveLength(1)
  })

  it('la traza de una de sus ejecuciones se lee', async () => {
    const session = new AssistantSession({ kind: 'task', ref: 'o/r#5' }, closed, () => {})
    await expect(session.trace('o/r#5', 'e2')).resolves.toBeDefined()
  })

  it('otra tarea sigue fuera de contexto', async () => {
    const session = new AssistantSession({ kind: 'task', ref: 'o/r#5' }, closed, () => {})
    await expect(session.taskDetail('o/r#6')).rejects.toThrow(/Fuera de contexto/)
  })

  it('en el contexto general, una tarea fuera del board no se lee', async () => {
    const session = new AssistantSession({ kind: 'general' }, closed, () => {})
    await expect(session.taskDetail('o/r#5')).rejects.toThrow(/no está en ningún board/)
  })
})
