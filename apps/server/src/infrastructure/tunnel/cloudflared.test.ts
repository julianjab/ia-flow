import { describe, expect, test } from 'bun:test'
import { CloudflaredTunnel, orphanPattern, parseTunnelUrl, webhookUrlFor } from './cloudflared.js'

describe('orphanPattern', () => {
  test('matches only the argv we spawn for that port', () => {
    expect(orphanPattern(3001)).toBe(
      'cloudflared tunnel --no-autoupdate --url http://localhost:3001',
    )
    expect(orphanPattern(3999)).not.toBe(orphanPattern(3001))
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
