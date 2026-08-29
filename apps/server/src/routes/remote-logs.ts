import { RemoteLogEntrySchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { providerRegistrationRepo } from '../composition/container.js'
import { ingestRemoteLogEntry } from '../logger.js'
import { attribute, resolveCaller } from './remote-logs-logic.js'

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

// Extra ceiling on top of the per-field limits in RemoteLogEntrySchema
// (module/msg): `extras` is an open record, so bound its serialized size too.
const MAX_EXTRAS_BYTES = 20_000

export function createRemoteLogsRouter() {
  const app = new Hono()

  app.post('/', async (c) => {
    const caller = resolveCaller(
      c.req.header('x-ia-flow-token'),
      remoteLogSecret(),
      providerRegistrationRepo.list(),
    )
    if (!caller) {
      // Se distingue "no hay ninguna credencial posible" de "la que trajiste no
      // sirve": son dos arreglos distintos para el operador, y sin la
      // distinción un agent-host mal configurado y un daemon sin token se ven
      // igual desde afuera. Sigue siendo fail-closed en los dos casos.
      if (!remoteLogSecret() && providerRegistrationRepo.list().length === 0) {
        return c.json(
          {
            error:
              'remote-logs endpoint disabled: no IA_FLOW_REMOTE_LOG_TOKEN and no provider registrations',
          },
          503,
        )
      }
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

    ingestRemoteLogEntry({ level, module, msg, extras: attribute(extras, caller) })

    return c.json({ ok: true })
  })

  return app
}
