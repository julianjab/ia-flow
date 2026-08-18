import { RemoteLogEntrySchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { createLogger } from '../logger.js'

// Ingests log lines forwarded by another ia-flow process whose logger.ts was
// configured with IA_FLOW_REMOTE_LOG_URL pointing here — e.g. the headless
// refiner engine container (apps/server/docker/README.md), which has no UI
// of its own to read daemon.log from. Each POST is re-emitted via
// createLogger(module), landing in this server's own daemon.log and WS
// broadcast exactly like a line logged locally.
export function createRemoteLogsRouter() {
  const app = new Hono()

  app.post('/', async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = RemoteLogEntrySchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'Invalid payload', issues: parsed.error.issues }, 400)
    }

    const { level, module, msg, extras } = parsed.data
    createLogger(module)[level](extras ?? {}, msg)

    return c.json({ ok: true })
  })

  return app
}
