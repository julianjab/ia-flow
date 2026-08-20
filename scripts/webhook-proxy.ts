#!/usr/bin/env bun
// Standalone reverse proxy for the GitHub webhook route. Runs *outside* the
// ia-flow server process, on its own port, so a persistent tunnel (cloudflared
// quick tunnel, ngrok, etc.) run manually on this machine never restarts when
// the server does (`bun --watch`, a deploy, a crash) and never exposes the
// full API.
//
// Why this exists: the API has no auth of its own — PUT /api/env-vars
// overwrites credentials, and the agent/tool endpoints run commands on this
// machine. Pointing a public tunnel straight at the server port would be RCE
// for whoever guesses the hostname. This proxy forwards exactly one route
// (POST /api/webhooks/github, which the server verifies via HMAC) and 404s
// everything else.
//
// Usage:
//   bun run scripts/webhook-proxy.ts
//   IA_FLOW_PROXY_PORT=8787 IA_FLOW_API_PORT=3001 bun run scripts/webhook-proxy.ts
//
// Then point a long-running tunnel at IA_FLOW_PROXY_PORT, e.g.:
//   cloudflared tunnel --url http://localhost:8787
// Keep that tunnel process running independently (tmux, a LaunchAgent, etc.)
// so it survives ia-flow server restarts.

const WEBHOOK_PATH = '/api/webhooks/github'

const apiPort = Number.parseInt(process.env.IA_FLOW_API_PORT ?? '3001', 10)
const proxyPort = Number.parseInt(process.env.IA_FLOW_PROXY_PORT ?? '8787', 10)

const server = Bun.serve({
  port: proxyPort,
  fetch: async (req) => {
    const url = new URL(req.url)
    if (req.method !== 'POST' || url.pathname !== WEBHOOK_PATH) {
      return new Response('Not found', { status: 404 })
    }
    const body = await req.arrayBuffer()
    let upstream: Response
    try {
      upstream = await fetch(`http://localhost:${apiPort}${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: req.headers,
        body,
      })
    } catch (err) {
      console.error(`upstream fetch failed: ${(err as Error).message}`)
      return new Response('Bad gateway', { status: 502 })
    }
    const headers = new Headers(upstream.headers)
    for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) {
      headers.delete(h)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  },
})

console.log(
  `webhook-proxy listening on :${server.port} → forwarding ${WEBHOOK_PATH} to :${apiPort}`,
)
console.log('point your tunnel at this port, not at the ia-flow API port directly')
