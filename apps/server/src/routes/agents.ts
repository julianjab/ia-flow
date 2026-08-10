import { Hono } from 'hono'
import {
  type AssistInput,
  AssistUpstreamError,
  AssistValidationError,
  type AssistWithAiUseCase,
} from '../application/use-cases/AssistWithAiUseCase.js'

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
      if (err instanceof AssistValidationError) return c.json({ error: err.message }, 400)
      if (err instanceof AssistUpstreamError) return c.json({ error: err.message }, 500)
      return c.json({ error: String(err) }, 500)
    }
  })

  return app
}
