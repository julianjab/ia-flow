import { describe, expect, test } from 'bun:test'
import {
  type WebhookHint,
  type WebhookTarget,
  deliverWebhook,
  hasWebhookTarget,
  listWebhookTargets,
  registerWebhookTarget,
  triggerWebhookTarget,
} from '../webhook-registry.js'

function makeTarget(
  projectId: string,
  matches: (hint: WebhookHint) => Promise<boolean> = async () => true,
): WebhookTarget & { reasons: string[] } {
  const reasons: string[] = []
  return {
    projectId,
    reasons,
    matches,
    trigger: (reason: string) => {
      reasons.push(reason)
    },
    stats: () => ({
      projectId,
      sourceKind: 'test',
      lastEventAt: null,
      lastReason: reasons.at(-1) ?? null,
      lastScanAt: null,
      scanning: false,
      fallbackIntervalMs: 0,
      deliveryReceived: false,
    }),
  }
}

describe('webhook-registry', () => {
  test('register / unregister round-trip', () => {
    const t = makeTarget('p1')
    const off = registerWebhookTarget(t)
    expect(hasWebhookTarget('p1')).toBe(true)
    expect(listWebhookTargets().map((s) => s.projectId)).toContain('p1')
    off()
    expect(hasWebhookTarget('p1')).toBe(false)
  })

  test('unregister of a replaced target leaves the newer one alone', () => {
    const older = makeTarget('p1')
    const offOlder = registerWebhookTarget(older)
    const newer = makeTarget('p1')
    const offNewer = registerWebhookTarget(newer)
    offOlder() // stale dispose from the previous manager generation
    expect(hasWebhookTarget('p1')).toBe(true)
    triggerWebhookTarget('p1', 'x')
    expect(newer.reasons).toEqual(['x'])
    expect(older.reasons).toEqual([])
    offNewer()
  })

  test('deliverWebhook only triggers matching targets', async () => {
    const a = makeTarget('a', async (h) => h.projectNodeId === 'PVT_a')
    const b = makeTarget('b', async (h) => h.projectNodeId === 'PVT_b')
    const offA = registerWebhookTarget(a)
    const offB = registerWebhookTarget(b)

    const triggered = await deliverWebhook({ event: 'projects_v2_item', projectNodeId: 'PVT_a' })

    expect(triggered).toEqual(['a'])
    expect(a.reasons).toEqual(['webhook:projects_v2_item'])
    expect(b.reasons).toEqual([])
    offA()
    offB()
  })

  test('a throwing matcher still triggers (fail-open)', async () => {
    const t = makeTarget('boom', async () => {
      throw new Error('network')
    })
    const off = registerWebhookTarget(t)
    const triggered = await deliverWebhook({ event: 'issues' })
    expect(triggered).toEqual(['boom'])
    expect(t.reasons).toEqual(['webhook:issues'])
    off()
  })

  test('triggerWebhookTarget reports unknown projects', () => {
    expect(triggerWebhookTarget('nope', 'manual')).toBe(false)
  })
})
