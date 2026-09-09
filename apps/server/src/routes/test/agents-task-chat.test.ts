import { describe, expect, it } from 'bun:test'
import type {
  AssistInput,
  AssistResult,
  AssistWithAiUseCase,
} from '../../application/use-cases/AssistWithAiUseCase.js'
import { TaskChatUseCase } from '../../application/use-cases/TaskChatUseCase.js'
import { createAgentsRouter } from '../agents.js'

// El use-case real llama a la API de Anthropic — acá se testea el borde HTTP
// más `TaskChatUseCase` (verificación de la salida del modelo), así que se
// inyecta un doble de `AssistWithAiUseCase` que devuelve lo que cada test
// necesita y se envuelve con el `TaskChatUseCase` real.
function fakeAssist(execute: (input: AssistInput) => Promise<AssistResult>): AssistWithAiUseCase {
  return { execute } as unknown as AssistWithAiUseCase
}

function routerWith(execute: (input: AssistInput) => Promise<AssistResult>) {
  const assist = fakeAssist(execute)
  return createAgentsRouter(assist, new TaskChatUseCase(assist))
}

const VALID_BODY = {
  projectId: 'p1',
  messages: [{ role: 'user', content: '¿Qué está bloqueado?' }],
  tasks: [{ id: 't1', title: 'Arreglar el bug', status: 'In Progress' }],
}

describe('POST /api/agents/task-chat', () => {
  it('400 si el body no matchea el schema (sin mensajes)', async () => {
    const app = routerWith(async () => ({ fields: {} }))
    const res = await app.request('/task-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', messages: [], tasks: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('400 si no hay ningún mensaje de rol "user"', async () => {
    const app = routerWith(async () => ({ fields: {} }))
    const res = await app.request('/task-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...VALID_BODY,
        messages: [{ role: 'assistant', content: 'hola' }],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('200 y {reply, actions} cuando el modelo devuelve un fill_form válido', async () => {
    const app = routerWith(async () => ({
      fields: {
        reply: 'Nada bloqueado ahora mismo.',
        actions: [{ type: 'set-field', itemId: 't1', field: 'status', value: 'Done' }],
      },
    }))
    const res = await app.request('/task-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      reply: string
      actions: { itemId: string; itemTitle?: string }[]
    }
    expect(body.reply).toBe('Nada bloqueado ahora mismo.')
    expect(body.actions).toHaveLength(1)
    // El itemTitle lo resuelve el server desde `tasks`, nunca lo que mande
    // el modelo — es lo que impide que el chip muestre una tarea distinta
    // de la que "Aplicar" va a mutar.
    expect(body.actions[0]?.itemTitle).toBe('Arreglar el bug')
  })

  it('descarta una acción cuyo itemId no vino en `tasks` — el modelo no es la fuente de qué tareas existen', async () => {
    const app = routerWith(async () => ({
      fields: {
        reply: 'ok',
        actions: [
          { type: 'set-field', itemId: 't1', field: 'status', value: 'Done' },
          { type: 'set-field', itemId: 'no-existe', field: 'status', value: 'Done' },
        ],
      },
    }))
    const res = await app.request('/task-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { actions: { itemId: string }[] }
    expect(body.actions.map((a) => a.itemId)).toEqual(['t1'])
  })

  it('ignora el itemTitle que manda el modelo y usa el de `tasks`', async () => {
    const app = routerWith(async () => ({
      fields: {
        reply: 'ok',
        actions: [
          {
            type: 'set-field',
            itemId: 't1',
            itemTitle: 'Un título inventado que no es el real',
            field: 'status',
            value: 'Done',
          },
        ],
      },
    }))
    const res = await app.request('/task-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    const body = (await res.json()) as { actions: { itemTitle?: string }[] }
    expect(body.actions[0]?.itemTitle).toBe('Arreglar el bug')
  })

  it('502 cuando el modelo no devuelve el formato esperado', async () => {
    const app = routerWith(async () => ({ fields: { garbage: true } }))
    const res = await app.request('/task-chat', {
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
    const app = routerWith(async () => {
      throw new AssistUpstreamError('Anthropic API error 500: boom', 500)
    })
    const res = await app.request('/task-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('boom')
  })
})
