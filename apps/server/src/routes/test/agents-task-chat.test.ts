import { describe, expect, it } from 'bun:test'
import type {
  AssistInput,
  AssistResult,
  AssistWithAiUseCase,
} from '../../application/use-cases/AssistWithAiUseCase.js'
import { createAgentsRouter } from '../agents.js'

// El use-case real llama a la API de Anthropic — acá se testea sólo el borde
// HTTP (validación, mapeo de errores, forma de la respuesta), así que se
// inyecta un doble que devuelve lo que cada test necesita.
function fakeAssist(execute: (input: AssistInput) => Promise<AssistResult>): AssistWithAiUseCase {
  return { execute } as unknown as AssistWithAiUseCase
}

const VALID_BODY = {
  projectId: 'p1',
  messages: [{ role: 'user', content: '¿Qué está bloqueado?' }],
  tasks: [{ id: 't1', title: 'Arreglar el bug', status: 'In Progress' }],
}

describe('POST /api/agents/task-chat', () => {
  it('400 si el body no matchea el schema (sin mensajes)', async () => {
    const app = createAgentsRouter(fakeAssist(async () => ({ fields: {} })))
    const res = await app.request('/task-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', messages: [], tasks: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('400 si no hay ningún mensaje de rol "user"', async () => {
    const app = createAgentsRouter(fakeAssist(async () => ({ fields: {} })))
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
    const app = createAgentsRouter(
      fakeAssist(async () => ({
        fields: {
          reply: 'Nada bloqueado ahora mismo.',
          actions: [{ type: 'set-field', itemId: 't1', field: 'status', value: 'Done' }],
        },
      })),
    )
    const res = await app.request('/task-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reply: string; actions: unknown[] }
    expect(body.reply).toBe('Nada bloqueado ahora mismo.')
    expect(body.actions).toHaveLength(1)
  })

  it('502 cuando el modelo no devuelve el formato esperado', async () => {
    const app = createAgentsRouter(fakeAssist(async () => ({ fields: { garbage: true } })))
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
    const app = createAgentsRouter(
      fakeAssist(async () => {
        throw new AssistUpstreamError('Anthropic API error 500: boom', 500)
      }),
    )
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
