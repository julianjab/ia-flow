import { timingSafeEqual } from 'crypto'
import { RemoteExecutionLogEntrySchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { executionLogRepo } from '../composition/container.js'
import { createLogger } from '../logger.js'

const log = createLogger('remote-executions-route')

// Ingests execution-log rows forwarded by another ia-flow process's
// IExecutionLogRepository — a headless engine container (e.g.
// agents/subscriptions-pipeline) composed with a CompositeExecutionLogRepository
// (local Sqlite + this remote forward, see infrastructure/db/RemoteExecutionLogRepository.ts)
// so the "Ejecuciones" tab on this server also shows their runs. Sibling
// endpoint to routes/remote-logs.ts, same shared-secret pattern; it applies
// the insert/update against THIS server's own execution_logs via
// executionLogRepo instead of appending to daemon.log.

// Read lazily, same rationale as remote-logs.ts: a secret stored in the DB
// (envRepo.loadIntoProcess) is picked up after module import.
function remoteExecutionsSecret(): string | undefined {
  const raw = process.env.IA_FLOW_REMOTE_LOG_TOKEN?.trim()
  return raw ? raw : undefined
}

function secretEquals(provided: string | undefined, secret: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function createRemoteExecutionsRouter() {
  const app = new Hono()

  app.post('/', async (c) => {
    const secret = remoteExecutionsSecret()
    if (!secret) {
      return c.json(
        {
          error: 'remote-executions endpoint disabled: IA_FLOW_REMOTE_LOG_TOKEN is not configured',
        },
        503,
      )
    }
    if (!secretEquals(c.req.header('x-ia-flow-token'), secret)) {
      return c.json({ error: 'invalid token' }, 401)
    }

    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = RemoteExecutionLogEntrySchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'Invalid payload', issues: parsed.error.issues }, 400)
    }

    try {
      if (parsed.data.op === 'insert') {
        executionLogRepo.insert(parsed.data.entry)
      } else {
        executionLogRepo.update(parsed.data.id, parsed.data.patch)
      }
    } catch (err) {
      // insert() upserts (see SqliteExecutionLogRepository), so this is a
      // genuine DB failure, not a duplicate-id retry — surface it instead
      // of a bare unhandled 500 so the sender's `warn` log has a real cause.
      log.error({ err, op: parsed.data.op }, 'Failed to apply forwarded execution log')
      return c.json({ error: 'Failed to apply execution log' }, 500)
    }

    return c.json({ ok: true })
  })

  return app
}
