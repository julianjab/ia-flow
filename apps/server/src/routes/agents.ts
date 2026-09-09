import { Hono } from 'hono'
import {
  type AssistInput,
  AssistUpstreamError,
  AssistValidationError,
  type AssistWithAiUseCase,
} from '../application/use-cases/AssistWithAiUseCase.js'

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

// El asistente de tareas (`POST /api/tasks/assistant/chat`) vive en
// `routes/task-chat.ts` — no acá. `/assist` es genérico (lo usa cualquier
// panel de la web que arme prompts para agentes/system prompts); el chat de
// Tareas tiene su propio router porque su path es `/api/tasks/assistant/*`.
export function createAgentsRouter(assistWithAi: AssistWithAiUseCase) {
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

  return app
}
