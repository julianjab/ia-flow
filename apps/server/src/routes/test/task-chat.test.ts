import { describe, expect, it } from 'bun:test'
import type { TaskAnnotation } from '@ia-flow/shared'
import type {
  AssistInput,
  AssistResult,
  AssistWithAiUseCase,
} from '../../application/use-cases/AssistWithAiUseCase.js'
import { TaskChatUseCase } from '../../application/use-cases/TaskChatUseCase.js'
import type { ITaskAnnotationRepository } from '../../domain/ports/ITaskAnnotationRepository.js'
import { createTaskChatRouter } from '../task-chat.js'

// El use-case real llama a la API de Anthropic — acá se testea el borde HTTP
// más `TaskChatUseCase` (verificación de la salida del modelo), así que se
// inyecta un doble de `AssistWithAiUseCase` que devuelve lo que cada test
// necesita y se envuelve con el `TaskChatUseCase` real.
function fakeAssist(execute: (input: AssistInput) => Promise<AssistResult>): AssistWithAiUseCase {
  return { execute } as unknown as AssistWithAiUseCase
}

function fakeAnnotationRepo(seed: TaskAnnotation[] = []): ITaskAnnotationRepository {
  const rows = [...seed]
  return {
    async create(note) {
      rows.push(note)
      return note
    },
    async listByTask(projectId, taskId) {
      return rows.filter((r) => r.projectId === projectId && r.taskId === taskId)
    },
    async delete(id) {
      const idx = rows.findIndex((r) => r.id === id)
      if (idx === -1) return false
      rows.splice(idx, 1)
      return true
    },
  }
}

function routerWith(
  execute: (input: AssistInput) => Promise<AssistResult>,
  annotationRepo: ITaskAnnotationRepository = fakeAnnotationRepo(),
) {
  const assist = fakeAssist(execute)
  const events: object[] = []
  const app = createTaskChatRouter(new TaskChatUseCase(assist, []), annotationRepo, (msg) =>
    events.push(msg),
  )
  return { app, events }
}

const VALID_BODY = {
  projectId: 'p1',
  message: '¿Qué está bloqueado?',
  tasks: [{ id: 't1', title: 'Arreglar el bug', status: 'In Progress' }],
}

describe('POST /api/tasks/assistant/chat', () => {
  it('400 si el body no matchea el schema (message vacío)', async () => {
    const { app } = routerWith(async () => ({ fields: {} }))
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, message: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('200 y {reply, scope, actions} cuando el modelo devuelve un fill_form válido', async () => {
    const { app, events } = routerWith(async () => ({
      fields: {
        reply: 'Nada bloqueado ahora mismo.',
        scope: { type: 'task', taskId: 't1' },
        actions: [{ type: 'tag', taskId: 't1', tags: ['urgente'] }],
      },
    }))
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      reply: string
      scope: { type: string; taskId?: string }
      actions: { type: string; taskId: string }[]
    }
    expect(body.reply).toBe('Nada bloqueado ahora mismo.')
    expect(body.scope).toEqual({ type: 'task', taskId: 't1' })
    expect(body.actions).toHaveLength(1)
    // El chat emite progreso vía el mismo canal WS que el resto de la app —
    // ver el comentario de `createTaskChatRouter` sobre por qué es parcial.
    expect(events.map((e) => (e as { phase: string }).phase)).toEqual(['started', 'done'])
  })

  it('descarta scope.taskId y acciones cuyo taskId no vino en `tasks` — el modelo no es la fuente de qué tareas existen', async () => {
    const { app } = routerWith(async () => ({
      fields: {
        reply: 'ok',
        scope: { type: 'task', taskId: 'no-existe' },
        actions: [
          { type: 'tag', taskId: 't1', tags: ['ok'] },
          { type: 'tag', taskId: 'no-existe', tags: ['ok'] },
        ],
      },
    }))
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      scope: { type: string }
      actions: { taskId: string }[]
    }
    expect(body.scope).toEqual({ type: 'project' })
    expect(body.actions.map((a) => a.taskId)).toEqual(['t1'])
  })

  it('reorder filtra los taskIds desconocidos preservando el orden de los conocidos', async () => {
    const { app } = routerWith(async () => ({
      fields: {
        reply: 'ok',
        scope: { type: 'project' },
        actions: [{ type: 'reorder', taskIds: ['no-existe', 't1'] }],
      },
    }))
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    const body = (await res.json()) as { actions: { taskIds: string[] }[] }
    expect(body.actions[0]?.taskIds).toEqual(['t1'])
  })

  it('502 cuando el modelo no devuelve el formato esperado', async () => {
    const { app } = routerWith(async () => ({ fields: { garbage: true } }))
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    expect(res.status).toBe(502)
  })

  it('500 y el mensaje del use-case cuando el upstream falla', async () => {
    const { AssistUpstreamError } = await import(
      '../../application/use-cases/AssistWithAiUseCase.js'
    )
    const { app } = routerWith(async () => {
      throw new AssistUpstreamError('Anthropic API error 500: boom', 500)
    })
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('boom')
  })
})

describe('CRUD de anotaciones (/api/tasks/assistant/notes)', () => {
  it('POST crea una anotación y GET la devuelve por (projectId, taskId)', async () => {
    const { app } = routerWith(async () => ({ fields: {} }))
    const created = await app.request('/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        taskId: 't1',
        text: 'Depende de #99',
        origin: 'assistant',
      }),
    })
    expect(created.status).toBe(201)

    const listed = await app.request('/notes?projectId=p1&taskId=t1')
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as { notes: { text: string }[] }
    expect(body.notes.map((n) => n.text)).toEqual(['Depende de #99'])
  })

  it('POST 400 sin projectId/taskId/text', async () => {
    const { app } = routerWith(async () => ({ fields: {} }))
    const res = await app.request('/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1' }),
    })
    expect(res.status).toBe(400)
  })

  it('GET 400 sin projectId o taskId', async () => {
    const { app } = routerWith(async () => ({ fields: {} }))
    const res = await app.request('/notes?projectId=p1')
    expect(res.status).toBe(400)
  })

  it('DELETE 200 cuando existe, 404 cuando no', async () => {
    const repo = fakeAnnotationRepo([
      { id: 'a1', projectId: 'p1', taskId: 't1', text: 'x', origin: 'assistant', createdAt: 'now' },
    ])
    const { app } = routerWith(async () => ({ fields: {} }), repo)
    const ok = await app.request('/notes/a1', { method: 'DELETE' })
    expect(ok.status).toBe(200)
    const missing = await app.request('/notes/a1', { method: 'DELETE' })
    expect(missing.status).toBe(404)
  })
})
