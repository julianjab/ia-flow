import { Hono } from 'hono'
import { broadcast } from '../composition/container.js'
import { tunnel } from '../infrastructure/tunnel/cloudflared.js'

// Operator control for the quick Cloudflare tunnel that makes
// POST /api/webhooks/github reachable from GitHub. See
// infrastructure/tunnel/cloudflared.ts for the lifecycle.
export function createTunnelRouter() {
  const router = new Hono()
  tunnel.setBroadcast((msg) => broadcast.send(msg))

  // The tunnel must point at the API port, not at Vite's dev server: in dev
  // the web is proxied through :5173, but GitHub POSTs straight to the API.
  const apiPort = (): number => Number.parseInt(Bun.env.PORT ?? '3001', 10)

  router.get('/', (c) => c.json(tunnel.status()))

  router.post('/start', async (c) => {
    const status = await tunnel.start(apiPort())
    // `error` here means "couldn't even launch" (binary missing) — a start
    // that launches but fails later reports through the status endpoint / WS.
    return c.json(status, status.state === 'error' ? 500 : 200)
  })

  router.post('/stop', async (c) => c.json(await tunnel.stop()))

  return router
}
