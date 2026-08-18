import { timingSafeEqual } from 'crypto'
import { RemoteLogEntrySchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { ingestRemoteLogEntry } from '../logger.js'

// Ingests log lines forwarded by another ia-flow process whose logger.ts was
// configured with IA_FLOW_REMOTE_LOG_URL pointing here — e.g. the headless
// refiner engine container (agents/functional-refiner/README.md), which has no UI
// of its own to read daemon.log from. Each POST lands in this server's own
// daemon.log and WS broadcast via ingestRemoteLogEntry — see logger.ts for
// why that path can never itself forward (loop prevention).

// Shared secret, same fail-closed pattern as routes/webhooks.ts: this
// endpoint writes into daemon.log and the live WS feed the UI renders, so
// with no secret configured it must refuse everything, not accept anything.
// Read lazily so a secret stored in the DB (envRepo.loadIntoProcess runs
// after module import) is picked up.
function remoteLogSecret(): string | undefined {
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

// Extra ceiling on top of the per-field limits in RemoteLogEntrySchema
// (module/msg): `extras` is an open record, so bound its serialized size too.
const MAX_EXTRAS_BYTES = 20_000

export function createRemoteLogsRouter() {
  const app = new Hono()

  app.post('/', async (c) => {
    const secret = remoteLogSecret()
    if (!secret) {
      return c.json(
        { error: 'remote-logs endpoint disabled: IA_FLOW_REMOTE_LOG_TOKEN is not configured' },
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

    const parsed = RemoteLogEntrySchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'Invalid payload', issues: parsed.error.issues }, 400)
    }

    const { level, module, msg, extras } = parsed.data
    if (extras && JSON.stringify(extras).length > MAX_EXTRAS_BYTES) {
      return c.json({ error: 'extras too large' }, 413)
    }

    ingestRemoteLogEntry({ level, module, msg, extras })

    return c.json({ ok: true })
  })

  return app
}
