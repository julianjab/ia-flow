/**
 * Las entradas del runner y lo que les llegó: el conteo y la lista salen del log de eventos,
 * filtrados por el prefijo de cada entrada.
 */
import { describe, expect, it } from 'bun:test'
import type { EventLogEntry } from '@ia-flow/shared'
import { IngressService } from './IngressService.js'

const entry = (id: string, type: string, occurred_at: string): EventLogEntry => ({
  id,
  type,
  occurred_at,
  depth: 0,
  summary: {},
  outcome: 'dispatched',
  decisions: [],
})

const events = [
  entry('e3', 'slack.message', '2026-09-30T11:00:00Z'),
  entry('e2', 'github.projects_v2_item', '2026-09-30T10:00:00Z'),
  entry('e1', 'github.push', '2026-09-28T10:00:00Z'),
]

const log = {
  ingressEvents: (prefix: string, limit: number) =>
    events.filter((e) => e.type.startsWith(prefix)).slice(0, limit),
  ingressCount: (prefix: string, since?: string) => {
    const hits = events.filter(
      (e) => e.type.startsWith(prefix) && (!since || e.occurred_at >= since),
    )
    return { count: hits.length, ...(hits[0] ? { lastAt: hits[0].occurred_at } : {}) }
  },
}

const service = new IngressService({
  log,
  retentionDays: 14,
  now: () => new Date('2026-09-30T12:00:00Z'),
  sources: [
    {
      id: 'github',
      name: 'GitHub',
      kind: 'webhook',
      endpoint: '/api/webhooks/github',
      configured: true,
    },
    { id: 'slack', name: 'Slack', kind: 'socket', configured: false, missing: 'SLACK_APP_TOKEN' },
  ],
})

describe('IngressService', () => {
  it('each ingress, with how much arrived in the last 24 h, how much is kept, and the last one', () => {
    expect(service.ingress()).toEqual({
      retention_days: 14,
      sources: [
        {
          id: 'github',
          name: 'GitHub',
          kind: 'webhook',
          endpoint: '/api/webhooks/github',
          configured: true,
          last_at: '2026-09-30T10:00:00Z',
          count_24h: 1,
          count_kept: 2,
        },
        {
          id: 'slack',
          name: 'Slack',
          kind: 'socket',
          configured: false,
          missing: 'SLACK_APP_TOKEN',
          last_at: '2026-09-30T11:00:00Z',
          count_24h: 1,
          count_kept: 1,
        },
      ],
    })
  })

  it("what arrived at one ingress, newest first; an unknown one doesn't exist", () => {
    expect(service.events('github')?.map((e) => e.id)).toEqual(['e2', 'e1'])
    expect(service.events('github', 1)?.map((e) => e.id)).toEqual(['e2'])
    expect(service.events('jira')).toBeUndefined()
  })
})
