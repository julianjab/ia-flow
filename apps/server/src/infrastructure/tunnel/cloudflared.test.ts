import { describe, expect, test } from 'bun:test'
import {
  CloudflaredTunnel,
  WEBHOOK_PATH,
  orphanPattern,
  parseTunnelUrl,
  startWebhookProxy,
  webhookUrlFor,
} from './cloudflared.js'

describe('orphanPattern', () => {
  test('matches only the argv we spawn for that port', () => {
    expect(orphanPattern(3001)).toBe(
      '^cloudflared tunnel --no-autoupdate --url http://localhost:3001$',
    )
    expect(orphanPattern(3999)).not.toBe(orphanPattern(3001))
  })

  test('is anchored so :3001 does not match a tunnel on :30011', () => {
    const re = new RegExp(orphanPattern(3001))
    expect(re.test('cloudflared tunnel --no-autoupdate --url http://localhost:3001')).toBe(true)
    expect(re.test('cloudflared tunnel --no-autoupdate --url http://localhost:30011')).toBe(false)
  })
})

describe('startWebhookProxy', () => {
  test('forwards the webhook route and 404s everything else', async () => {
    // Stand-in for the API: echoes what it received so we can assert the
    // proxy passes method, path and body through untouched.
    const api = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url)
        if (url.pathname !== WEBHOOK_PATH) return new Response('nope', { status: 418 })
        return new Response(
          JSON.stringify({ sig: req.headers.get('x-hub-signature-256'), body: await req.text() }),
          { status: 200 },
        )
      },
    })
    const proxy = startWebhookProxy(api.port)
    const base = `http://localhost:${proxy.port}`

    const ok = await fetch(`${base}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=abc' },
      body: '{"zen":"hi"}',
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ sig: 'sha256=abc', body: '{"zen":"hi"}' })

    // Everything the local API exposes stays unreachable through the tunnel.
    for (const [method, path] of [
      ['PUT', '/api/env-vars'],
      ['GET', '/api/projects'],
      ['POST', '/api/tasks'],
      ['GET', WEBHOOK_PATH],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method })
      expect(res.status).toBe(404)
    }

    proxy.stop()
    api.stop(true)
  })
})

describe('parseTunnelUrl', () => {
  test('finds the hostname in the banner line cloudflared prints', () => {
    const line =
      '2026-08-14T10:00:00Z INF |  https://calm-river-pine-1234.trycloudflare.com                    |'
    expect(parseTunnelUrl(line)).toBe('https://calm-river-pine-1234.trycloudflare.com')
  })

  test('ignores unrelated output', () => {
    expect(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull()
    expect(parseTunnelUrl('')).toBeNull()
    expect(parseTunnelUrl('https://example.com')).toBeNull()
  })
})

describe('webhookUrlFor', () => {
  test('appends the GitHub delivery path', () => {
    expect(webhookUrlFor('https://x.trycloudflare.com')).toBe(
      'https://x.trycloudflare.com/api/webhooks/github',
    )
  })

  test('tolerates a trailing slash and passes null through', () => {
    expect(webhookUrlFor('https://x.trycloudflare.com/')).toBe(
      'https://x.trycloudflare.com/api/webhooks/github',
    )
    expect(webhookUrlFor(null)).toBeNull()
  })
})

describe('CloudflaredTunnel', () => {
  test('starts stopped, with no url and no error', () => {
    const status = new CloudflaredTunnel().status()
    expect(status.state).toBe('stopped')
    expect(status.url).toBeNull()
    expect(status.webhookUrl).toBeNull()
    expect(status.error).toBeNull()
    expect(status.recentLog).toEqual([])
  })

  test('stop() on a tunnel that never started is a no-op', async () => {
    const t = new CloudflaredTunnel()
    const status = await t.stop()
    expect(status.state).toBe('stopped')
  })

  test('reports an error instead of spawning when the binary is missing', async () => {
    const t = new CloudflaredTunnel()
    // Pretend cloudflared isn't on PATH.
    t.binaryPath = () => null
    const status = await t.start(3001)
    expect(status.state).toBe('error')
    expect(status.installed).toBe(false)
    expect(status.error).toContain('brew install cloudflared')
  })

  test('a stop() during start() wins — no tunnel is left open', async () => {
    const t = new CloudflaredTunnel()
    // Pass the installed check without reaching a real spawn: stop() bumps the
    // generation while start() is still awaiting reapOrphans, so start aborts.
    t.binaryPath = () => '/opt/homebrew/bin/cloudflared'
    const starting = t.start(3997)
    const stopped = await t.stop()
    await starting

    expect(stopped.state).toBe('stopped')
    expect(t.status().state).toBe('stopped')
    expect(t.status().url).toBeNull()
    // Belt and braces: if the guard ever regresses, don't leak a process.
    await t.stop()
  })

  test('broadcasts every state change so open tabs stay in sync', async () => {
    const t = new CloudflaredTunnel()
    t.binaryPath = () => null
    const seen: Array<Record<string, unknown>> = []
    t.setBroadcast((msg) => seen.push(msg as Record<string, unknown>))

    await t.start(3001)
    await t.stop()

    expect(seen.map((m) => m.type)).toEqual(['tunnel:status', 'tunnel:status'])
    expect(seen[0]?.state).toBe('error')
    expect(seen[1]?.state).toBe('stopped')
  })
})
