import { ExecutionLogFiltersSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { executionLogRepo } from '../composition/container.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export function createExecutionsRouter() {
  const app = new Hono()

  app.get('/', (c) => {
    const q = c.req.query()
    const rawLimit = q.limit !== undefined ? Number(q.limit) : undefined
    const parsed = ExecutionLogFiltersSchema.safeParse({
      projectId: q.projectId,
      taskId: q.taskId,
      agentId: q.agentId,
      providerId: q.providerId,
      outcome: q.outcome,
      from: q.from,
      to: q.to,
      limit: Number.isNaN(rawLimit) ? undefined : rawLimit,
    })
    if (!parsed.success) {
      return c.json({ error: 'Invalid query params', issues: parsed.error.issues }, 400)
    }

    const filters = parsed.data
    filters.limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT)

    const executions = executionLogRepo.list(filters)
    return c.json({ executions })
  })

  return app
}
