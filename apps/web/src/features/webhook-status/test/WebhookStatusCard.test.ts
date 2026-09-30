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

async function mountCard() {
  const wrapper = mount(WebhookStatusCard)
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
    getWebhookStatusMock.mockResolvedValue({
      defaultMode: 'webhook',
      secretConfigured: false,
      endpoint: '/api/webhooks/github',
      projects: [],
    })
    const wrapper = await mountCard()
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

  it('shows the error and what to check when the runner does not answer', async () => {
    getWebhookStatusMock.mockRejectedValue(new Error('runner caído'))
    const wrapper = await mountCard()
    expect(wrapper.find('[role="alert"]').text()).toContain('✕ runner caído')
    expect(wrapper.text()).toContain('/api/webhooks/status')
  })

  it('reloads on demand', async () => {
    const wrapper = await mountCard()
    getWebhookStatusMock.mockClear()
    await wrapper.find('.btn').trigger('click')
    expect(getWebhookStatusMock).toHaveBeenCalledTimes(1)
  })
})
