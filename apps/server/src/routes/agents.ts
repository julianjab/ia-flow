import { TaskChatRequestSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import {
  type AssistInput,
  AssistUpstreamError,
  AssistValidationError,
  type AssistWithAiUseCase,
} from '../application/use-cases/AssistWithAiUseCase.js'
import type { TaskChatUseCase } from '../application/use-cases/TaskChatUseCase.js'

/** Comparten la misma taxonomía de errores que `/assist`: validación → 400,
 *  falla upstream → su status, cualquier otra cosa → 500 genérico. */
function assistErrorResponse(err: unknown): { body: { error: string }; status: 400 | 500 | 502 } {
  if (err instanceof AssistValidationError) return { body: { error: err.message }, status: 400 }
  if (err instanceof AssistUpstreamError) {
    const status = err.status === 502 ? 502 : 500
    return { body: { error: err.message }, status }
  }
  return { body: { error: String(err) }, status: 500 }
}

export function createAgentsRouter(assistWithAi: AssistWithAiUseCase, taskChat: TaskChatUseCase) {
  const app = new Hono()

  app.post('/assist', async (c) => {
    let body: AssistInput
    try {
      body = (await c.req.json()) as AssistInput
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    try {
      const result = await assistWithAi.execute(body)
      return c.json(result)
    } catch (err) {
      const { body: errBody, status } = assistErrorResponse(err)
      return c.json(errBody, status)
    }
  })

  app.post('/task-chat', async (c) => {
    let json: unknown
    try {
      json = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    const parsed = TaskChatRequestSchema.safeParse(json)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400)
    }
    if (!parsed.data.messages.some((m) => m.role === 'user')) {
      return c.json({ error: 'messages must include at least one user message' }, 400)
    }

    try {
      const result = await taskChat.execute(parsed.data)
      return c.json(result)
    } catch (err) {
      const { body, status } = assistErrorResponse(err)
      return c.json(body, status)
    }
  })

  return app
}
