import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebhookStatus } from '../api'

const getWebhookStatusMock = vi.fn<[], Promise<WebhookStatus>>()
vi.mock('../api', () => ({
  getWebhookStatus: () => getWebhookStatusMock(),
}))

import WebhookStatusCard from '../WebhookStatusCard.vue'

function webhookStatus(
  mode: 'webhook' | 'polling',
  deliveryReceived: boolean,
  fallbackIntervalMs = 0,
): WebhookStatus {
  return {
    defaultMode: 'webhook',
    secretConfigured: true,
    endpoint: '/api/webhooks/github',
    projects: [
      {
        projectId: 'p1',
        name: 'Proyecto Uno',
        mode,
        webhook:
          mode === 'webhook'
            ? {
                lastEventAt: null,
                lastReason: null,
                lastScanAt: null,
                fallbackIntervalMs,
                deliveryReceived,
              }
            : null,
      },
    ],
  }
}

async function mountCard(secretConfigured = true) {
  const wrapper = mount(WebhookStatusCard, { props: { secretConfigured } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  getWebhookStatusMock.mockResolvedValue({
    defaultMode: 'webhook',
    secretConfigured: true,
    endpoint: '/api/webhooks/github',
    projects: [],
  })
})

describe('WebhookStatusCard', () => {
  it('warns that the endpoint answers 503 while the secret is missing', async () => {
    const wrapper = await mountCard(false)
    expect(wrapper.text()).toContain('IA_FLOW_WEBHOOK_SECRET')
    expect(wrapper.text()).toContain('503')
  })

  it('points at the standalone proxy instead of an app-managed tunnel', async () => {
    const wrapper = await mountCard()
    expect(wrapper.text()).toContain('scripts/webhook-proxy.ts')
  })

  it('says a webhook project waits for deliveries instead of pulling', async () => {
    getWebhookStatusMock.mockResolvedValue(webhookStatus('webhook', false))
    const wrapper = await mountCard()
    expect(wrapper.text()).toContain('Proyecto Uno')
    expect(wrapper.text()).toContain('no hace pull, espera el webhook')
  })

  it('mentions the safety-net scan only when one is configured', async () => {
    getWebhookStatusMock.mockResolvedValue(webhookStatus('webhook', false, 900000))
    const wrapper = await mountCard()
    expect(wrapper.text()).toContain('sólo el scan de respaldo')
  })

  it('reports a project that is really in polling mode', async () => {
    getWebhookStatusMock.mockResolvedValue(webhookStatus('polling', false))
    const wrapper = await mountCard()
    expect(wrapper.text()).toContain('polling')
    expect(wrapper.text()).toContain('pull en cada intervalo')
  })
})
