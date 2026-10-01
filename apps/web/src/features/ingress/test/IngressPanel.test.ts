import type { EventLogEntry, Ingress } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getIngress = vi.fn()
const getIngressEvents = vi.fn()
vi.mock('../api', () => ({
  getIngress: () => getIngress(),
  getIngressEvents: (id: string) => getIngressEvents(id),
}))

import IngressPanel from '../IngressPanel.vue'

const ingress: Ingress = {
  retention_days: 14,
  sources: [
    {
      id: 'github',
      name: 'GitHub',
      kind: 'webhook',
      endpoint: '/api/webhooks/github',
      configured: true,
      count_24h: 3,
      count_kept: 40,
      last_at: new Date().toISOString(),
    },
    {
      id: 'slack',
      name: 'Slack',
      kind: 'socket',
      configured: false,
      missing: 'SLACK_APP_TOKEN',
      count_24h: 0,
      count_kept: 0,
    },
  ],
}

const event = (id: string, type: string, task?: string): EventLogEntry => ({
  id,
  type,
  occurred_at: '2026-09-30T11:00:00Z',
  depth: 0,
  ...(task ? { task_ref: task } : {}),
  summary: { action: 'edited' },
  outcome: 'dispatched',
  decisions: [{ source_id: 'runner', pipeline_id: 'intake', verdict: 'ran' }],
})

describe('IngressPanel', () => {
  beforeEach(() => {
    getIngress.mockReset().mockResolvedValue(ingress)
    getIngressEvents
      .mockReset()
      .mockImplementation(async (id: string) =>
        id === 'github' ? [event('e1', 'github.projects_v2_item', 'o/r#1')] : [],
      )
  })

  it('una tarjeta por entrada: cómo se conecta, si está configurada y cuánto le llegó', async () => {
    const w = mount(IngressPanel)
    await flushPromises()
    const github = w.get('[data-test="source-github"]').text()
    expect(github).toContain('POST /api/webhooks/github')
    expect(github).toContain('✓ configurada')
    expect(github).toContain('3 en 24 h')
    expect(w.get('[data-test="source-slack"]').text()).toContain('falta SLACK_APP_TOKEN')
  })

  it('abre la primera que recibe algo, con lo que llegó y de qué tarea es', async () => {
    const w = mount(IngressPanel)
    await flushPromises()
    expect(w.get('[data-test="source-github"]').attributes('aria-pressed')).toBe('true')
    expect(w.text()).toContain('github.projects_v2_item')
    expect(w.text()).toContain('o/r#1')
    expect(w.text()).toContain('✓ corrió intake')
  })

  it('elegir otra entrada muestra lo suyo', async () => {
    const w = mount(IngressPanel)
    await flushPromises()
    await w.get('[data-test="source-slack"]').trigger('click')
    await flushPromises()
    expect(getIngressEvents).toHaveBeenLastCalledWith('slack')
    expect(w.text()).toContain('Todavía no llegó nada por acá.')
  })
})
