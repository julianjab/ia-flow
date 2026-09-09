import { afterEach, describe, expect, it } from 'bun:test'
import type { IssueItem } from '@ia-flow/issue-sources'
import type { ProjectReadPort } from '../../contract.js'
import { getAllTools, getToolDefinitions } from '../../engine.js'
import {
  CHAT_ASSISTANT_READ_TOOLS,
  getProjectReadPort,
  getTaskDetail,
  listTasks,
  searchTasks,
  setProjectReadPort,
} from '../task-read.js'

function issue(overrides: Partial<IssueItem> = {}): IssueItem {
  return {
    id: 'i1',
    title: 'Arreglar el login',
    description: 'El botón de login no responde en mobile',
    status: 'Build',
    type: 'technical',
    repos: ['ia-flow'],
    labels: ['bug'],
    assignees: ['julian'],
    issueUrl: 'https://github.com/julianjab/ia-flow/issues/1',
    meta: { priority: 'high' },
    ...overrides,
  }
}

afterEach(() => {
  setProjectReadPort(null)
})

describe('get_task_detail / list_tasks / search_tasks — no se registran en el engine', () => {
  it('no aparecen en getAllTools() ni en getToolDefinitions()', () => {
    const names = getAllTools().map((t) => t.name)
    expect(names).not.toContain('get_task_detail')
    expect(names).not.toContain('list_tasks')
    expect(names).not.toContain('search_tasks')

    const defs = getToolDefinitions().map((d) => (d as { name: string }).name)
    expect(defs).not.toContain('get_task_detail')
    expect(defs).not.toContain('list_tasks')
    expect(defs).not.toContain('search_tasks')
  })

  it('están disponibles como export directo para el asistente de chat', () => {
    expect(CHAT_ASSISTANT_READ_TOOLS.map((t) => t.name)).toEqual([
      'get_task_detail',
      'list_tasks',
      'search_tasks',
    ])
  })
})

describe('ProjectReadPort — wireo', () => {
  it('sin port wireado, las tres tools rechazan', async () => {
    expect(getProjectReadPort()).toBeNull()
    await expect(getTaskDetail.execute({ project_id: 'p1', task_id: 'i1' })).rejects.toThrow(
      'no está wireado',
    )
    await expect(listTasks.execute({ project_id: 'p1' })).rejects.toThrow('no está wireado')
    await expect(searchTasks.execute({ project_id: 'p1', query: 'x' })).rejects.toThrow(
      'no está wireado',
    )
  })
})

describe('get_task_detail', () => {
  it('devuelve título, descripción, status, assignees, labels, url y comentarios', async () => {
    const target = issue()
    setProjectReadPort({
      async listItems() {
        return []
      },
      async getItem(projectId, itemId) {
        expect(projectId).toBe('p1')
        expect(itemId).toBe('i1')
        return target
      },
      async loadComments() {
        return [{ body: 'un comentario', created_at: '2026-01-01T00:00:00Z' }]
      },
    } satisfies ProjectReadPort)

    const raw = await getTaskDetail.execute({ project_id: 'p1', task_id: 'i1' })
    const parsed = JSON.parse(raw)
    expect(parsed).toMatchObject({
      id: 'i1',
      title: 'Arreglar el login',
      description: 'El botón de login no responde en mobile',
      status: 'Build',
      priority: 'high',
      assignees: ['julian'],
      labels: ['bug'],
      url: 'https://github.com/julianjab/ia-flow/issues/1',
      comments: [{ body: 'un comentario', created_at: '2026-01-01T00:00:00Z' }],
    })
  })

  it('devuelve un mensaje explícito cuando el issue no existe', async () => {
    setProjectReadPort({
      async listItems() {
        return []
      },
      async getItem() {
        return null
      },
      async loadComments() {
        return []
      },
    })
    const raw = await getTaskDetail.execute({ project_id: 'p1', task_id: 'missing' })
    expect(raw).toContain("No se encontró ningún issue con id 'missing'")
  })
})

describe('list_tasks', () => {
  it('devuelve todos los items sin requerir un run activo', async () => {
    const items = [
      issue({ id: 'i1', title: 'Uno' }),
      issue({ id: 'i2', title: 'Dos', status: 'Refine', meta: { priority: 'low' } }),
    ]
    setProjectReadPort({
      async listItems(projectId) {
        expect(projectId).toBe('p1')
        return items
      },
      async getItem() {
        return null
      },
      async loadComments() {
        return []
      },
    })
    const raw = await listTasks.execute({ project_id: 'p1' })
    const parsed = JSON.parse(raw)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ id: 'i1', title: 'Uno', status: 'Build', priority: 'high' })
    expect(parsed[1]).toMatchObject({ id: 'i2', title: 'Dos', status: 'Refine', priority: 'low' })
  })
})

describe('search_tasks', () => {
  const items = [
    issue({ id: 'i1', title: 'Arreglar el login', description: 'auth roto' }),
    issue({ id: 'i2', title: 'Agregar dark mode', description: 'tema oscuro para la web' }),
  ]

  it('filtra por título o descripción, case-insensitive, sin request extra', async () => {
    let listCalls = 0
    setProjectReadPort({
      async listItems() {
        listCalls++
        return items
      },
      async getItem() {
        return null
      },
      async loadComments() {
        return []
      },
    })
    const raw = await searchTasks.execute({ project_id: 'p1', query: 'LOGIN' })
    const parsed = JSON.parse(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe('i1')
    expect(listCalls).toBe(1)
  })

  it('matchea por descripción aunque el título no contenga el query', async () => {
    setProjectReadPort({
      async listItems() {
        return items
      },
      async getItem() {
        return null
      },
      async loadComments() {
        return []
      },
    })
    const raw = await searchTasks.execute({ project_id: 'p1', query: 'oscuro' })
    const parsed = JSON.parse(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe('i2')
  })

  it('sin matches devuelve un array vacío', async () => {
    setProjectReadPort({
      async listItems() {
        return items
      },
      async getItem() {
        return null
      },
      async loadComments() {
        return []
      },
    })
    const raw = await searchTasks.execute({ project_id: 'p1', query: 'no existe esto' })
    expect(JSON.parse(raw)).toEqual([])
  })
})
