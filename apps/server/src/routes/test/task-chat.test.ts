import { describe, expect, it } from 'bun:test'
import type {
  AssistInput,
  AssistResult,
  AssistWithAiUseCase,
} from '../../application/use-cases/AssistWithAiUseCase.js'
import { TaskChatUseCase } from '../../application/use-cases/TaskChatUseCase.js'
import { createTaskChatRouter } from '../task-chat.js'

// El use-case real llama a la API de Anthropic — acá se testea el borde HTTP
// más `TaskChatUseCase` (verificación de la salida del modelo), así que se
// inyecta un doble de `AssistWithAiUseCase` que devuelve lo que cada test
// necesita y se envuelve con el `TaskChatUseCase` real.
function fakeAssist(execute: (input: AssistInput) => Promise<AssistResult>): AssistWithAiUseCase {
  return { execute } as unknown as AssistWithAiUseCase
}

function routerWith(execute: (input: AssistInput) => Promise<AssistResult>) {
  const assist = fakeAssist(execute)
  const events: object[] = []
  const app = createTaskChatRouter(new TaskChatUseCase(assist, []), (msg) => events.push(msg))
  return { app, events }
}

const VALID_BODY = {
  projectId: 'p1',
  message: '¿Qué está bloqueado?',
  tasks: [
    { id: 't1', title: 'Arreglar el bug', status: 'In Progress', disposition: 'waiting-on-you' },
  ],
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

  it('group filtra los taskIds desconocidos dentro de cada grupo', async () => {
    const { app } = routerWith(async () => ({
      fields: {
        reply: 'ok',
        scope: { type: 'project' },
        actions: [{ type: 'group', groups: [{ label: 'bugs', taskIds: ['t1', 'no-existe'] }] }],
      },
    }))
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    const body = (await res.json()) as {
      actions: { type: string; groups: { label: string; taskIds: string[] }[] }[]
    }
    expect(body.actions).toEqual([{ type: 'group', groups: [{ label: 'bugs', taskIds: ['t1'] }] }])
  })

  it('group descarta ids de tareas que no están en el bucket "waiting-on-you" — ahí no se ve ningún grupo', async () => {
    const body = {
      ...VALID_BODY,
      tasks: [
        ...VALID_BODY.tasks,
        { id: 't2', title: 'Ya en review', status: 'Review', disposition: 'moving' },
      ],
    }
    const { app } = routerWith(async () => ({
      fields: {
        reply: 'ok',
        scope: { type: 'project' },
        actions: [{ type: 'group', groups: [{ label: 'bugs', taskIds: ['t1', 't2'] }] }],
      },
    }))
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const responseBody = (await res.json()) as {
      actions: { type: string; groups: { label: string; taskIds: string[] }[] }[]
    }
    expect(responseBody.actions).toEqual([
      { type: 'group', groups: [{ label: 'bugs', taskIds: ['t1'] }] },
    ])
  })

  it('group sin el campo `groups` defaultea a [] en vez de rechazar la respuesta con 502', async () => {
    const { app } = routerWith(async () => ({
      fields: { reply: 'ok', scope: { type: 'project' }, actions: [{ type: 'group' }] },
    }))
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { actions: { type: string; groups: unknown[] }[] }
    expect(body.actions).toEqual([{ type: 'group', groups: [] }])
  })

  it('group con `groups: []` (desagrupar) pasa sin filtrar', async () => {
    const { app } = routerWith(async () => ({
      fields: { reply: 'ok', scope: { type: 'project' }, actions: [{ type: 'group', groups: [] }] },
    }))
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    const body = (await res.json()) as { actions: { type: string; groups: unknown[] }[] }
    expect(body.actions).toEqual([{ type: 'group', groups: [] }])
  })

  it('group descarta la acción entera si TODOS sus grupos quedan vacíos tras filtrar', async () => {
    const { app } = routerWith(async () => ({
      fields: {
        reply: 'ok',
        scope: { type: 'project' },
        actions: [{ type: 'group', groups: [{ label: 'bugs', taskIds: ['no-existe'] }] }],
      },
    }))
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    const body = (await res.json()) as { actions: unknown[] }
    expect(body.actions).toEqual([])
  })

  it('un tema con label o taskIds vacíos NO tira toda la respuesta con 502 — se descarta ese grupo nomás', async () => {
    const { app } = routerWith(async () => ({
      fields: {
        reply: 'Te agrupé lo que pude.',
        scope: { type: 'project' },
        actions: [
          {
            type: 'group',
            groups: [
              { label: '', taskIds: [] },
              { label: 'bugs', taskIds: ['t1'] },
            ],
          },
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
      reply: string
      actions: { type: string; groups: { label: string; taskIds: string[] }[] }[]
    }
    expect(body.reply).toBe('Te agrupé lo que pude.')
    expect(body.actions).toEqual([{ type: 'group', groups: [{ label: 'bugs', taskIds: ['t1'] }] }])
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
