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
    // Collect repeated ?agentId=a&agentId=b etc. as arrays so the UI can
    // pass a multi-select set. Falls back to the single-value form when the
    // key appears once.
    const many = (key: string): string | string[] | undefined => {
      const values = c.req.queries(key) ?? []
      if (values.length > 1) return values
      if (values.length === 1) return values[0]
      return q[key]
    }
    const parsed = ExecutionLogFiltersSchema.safeParse({
      projectId: q.projectId,
      taskId: q.taskId,
      agentId: many('agentId'),
      providerId: many('providerId'),
      outcome: many('outcome'),
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
