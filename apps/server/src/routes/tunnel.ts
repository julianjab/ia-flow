import { Hono } from 'hono'
import { broadcast } from '../composition/container.js'
import { tunnel } from '../infrastructure/tunnel/cloudflared.js'
import { createLogger } from '../logger.js'

const log = createLogger('tunnel-route')

// Operator control for the quick Cloudflare tunnel that makes
// POST /api/webhooks/github reachable from GitHub. See
// infrastructure/tunnel/cloudflared.ts for the lifecycle.

// Opening a tunnel is the one local action with an effect *outside* this
// machine, so it must not be reachable as a CSRF "simple request": any page the
// user happens to have open could otherwise POST here and publish a hostname.
// Requiring a custom header forces a preflight, which the browser refuses to
// send cross-origin without our CORS blessing. The web client sends it on every
// mutating tunnel call.
const GUARD_HEADER = 'x-ia-flow-local'

function fromLocalClient(headerValue: string | undefined): boolean {
  return headerValue === '1'
}

export function createTunnelRouter() {
  const router = new Hono()
  tunnel.setBroadcast((msg) => broadcast.send(msg))

  // The tunnel must point at the API port, not at Vite's dev server: in dev
  // the web is proxied through :5173, but GitHub POSTs straight to the API.
  const apiPort = (): number => Number.parseInt(Bun.env.PORT ?? '3001', 10)

  router.use('/start', async (c, next) => {
    if (!fromLocalClient(c.req.header(GUARD_HEADER))) {
      log.warn({ origin: c.req.header('origin') }, 'Rejected tunnel start without local header')
      return c.json({ error: `missing ${GUARD_HEADER} header` }, 403)
    }
    await next()
  })
  router.use('/stop', async (c, next) => {
    if (!fromLocalClient(c.req.header(GUARD_HEADER))) {
      return c.json({ error: `missing ${GUARD_HEADER} header` }, 403)
    }
    await next()
  })

  router.get('/', (c) => c.json(tunnel.status()))

  router.post('/start', async (c) => {
    const status = await tunnel.start(apiPort())
    // `error` here means "couldn't even launch" (binary missing, spawn failed)
    // — a start that launches but fails later reports through status / WS.
    return c.json(status, status.state === 'error' ? 500 : 200)
  })

  router.post('/stop', async (c) => c.json(await tunnel.stop()))

  return router
}
