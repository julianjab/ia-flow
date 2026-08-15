import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TunnelStatus, WebhookStatus } from './api'

// ─── Module mocks ─────────────────────────────────────────────────────────
const getTunnelStatusMock = vi.fn<[], Promise<TunnelStatus>>()
const startTunnelMock = vi.fn<[], Promise<TunnelStatus>>()
const stopTunnelMock = vi.fn<[], Promise<TunnelStatus>>()
const getWebhookStatusMock = vi.fn<[], Promise<WebhookStatus>>()
vi.mock('./api', () => ({
  getTunnelStatus: () => getTunnelStatusMock(),
  startTunnel: () => startTunnelMock(),
  stopTunnel: () => stopTunnelMock(),
  getWebhookStatus: () => getWebhookStatusMock(),
}))
// happy-dom ships no usable WebSocket and the live channel isn't under test.
vi.mock('@/composables/useServerEvents', () => ({
  useServerEvents: () => ({ connected: { value: false } }),
}))

import TunnelCard from './TunnelCard.vue'

function status(overrides: Partial<TunnelStatus> = {}): TunnelStatus {
  return {
    state: 'stopped',
    url: null,
    webhookUrl: null,
    startedAt: null,
    error: null,
    installed: true,
    recentLog: [],
    ...overrides,
  }
}

const RUNNING = status({
  state: 'running',
  url: 'https://calm-river.trycloudflare.com',
  webhookUrl: 'https://calm-river.trycloudflare.com/api/webhooks/github',
  startedAt: '2026-08-14T10:00:00.000Z',
})

async function mountCard(secretConfigured = true) {
  const wrapper = mount(TunnelCard, { props: { secretConfigured } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getTunnelStatusMock.mockResolvedValue(status())
  startTunnelMock.mockResolvedValue(status({ state: 'starting' }))
  stopTunnelMock.mockResolvedValue(status())
  getWebhookStatusMock.mockResolvedValue({
    defaultMode: 'webhook',
    secretConfigured: true,
    endpoint: '/api/webhooks/github',
    projects: [],
  })
})

function webhookStatus(
  mode: 'webhook' | 'polling',
  deliveryReceived: boolean,
  fallbackIntervalMs = 0, // default del server: sin pull de respaldo
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

describe('TunnelCard', () => {
  it('offers to open the tunnel when stopped', async () => {
    const wrapper = await mountCard()
    expect(wrapper.text()).toContain('cerrado')
    expect(wrapper.find('.save-button').text()).toContain('Abrir túnel')
  })

  it('starts the tunnel on click', async () => {
    const wrapper = await mountCard()
    await wrapper.find('.save-button').trigger('click')
    await flushPromises()
    expect(startTunnelMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('abriendo')
  })

  it('shows the webhook URL once running', async () => {
    getTunnelStatusMock.mockResolvedValue(RUNNING)
    const wrapper = await mountCard()
    expect(wrapper.text()).toContain('https://calm-river.trycloudflare.com/api/webhooks/github')
    expect(wrapper.text()).toContain('Projects v2 item')
    expect(wrapper.text()).toContain('Cerrar túnel')
  })

  it('warns that the endpoint answers 503 while the secret is missing', async () => {
    getTunnelStatusMock.mockResolvedValue(RUNNING)
    const wrapper = await mountCard(false)
    expect(wrapper.text()).toContain('IA_FLOW_WEBHOOK_SECRET')
    expect(wrapper.text()).toContain('503')
  })

  it('states that only the webhook route is exposed', async () => {
    getTunnelStatusMock.mockResolvedValue(RUNNING)
    const wrapper = await mountCard()
    expect(wrapper.text()).toContain('únicamente')
    expect(wrapper.text()).toContain('POST /api/webhooks/github')
  })

  it('blocks the button and explains how to install a missing cloudflared', async () => {
    getTunnelStatusMock.mockResolvedValue(status({ installed: false }))
    const wrapper = await mountCard()
    expect(wrapper.text()).toContain('brew install cloudflared')
    expect(wrapper.find('.save-button').attributes('disabled')).toBeDefined()
  })

  it('surfaces a start failure and its cloudflared output', async () => {
    getTunnelStatusMock.mockResolvedValue(
      status({
        state: 'error',
        error: 'cloudflared terminó inesperadamente (exit 1)',
        recentLog: ['ERR failed to dial'],
      }),
    )
    const wrapper = await mountCard()
    expect(wrapper.text()).toContain('cloudflared terminó inesperadamente')
    expect(wrapper.text()).toContain('ERR failed to dial')
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

  it('stops polling when unmounted while the tunnel is still starting', async () => {
    vi.useFakeTimers()
    getTunnelStatusMock.mockResolvedValue(status({ state: 'starting' }))
    const wrapper = mount(TunnelCard, { props: { secretConfigured: true } })
    await flushPromises()
    const callsWhileMounted = getTunnelStatusMock.mock.calls.length

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(getTunnelStatusMock.mock.calls.length).toBe(callsWhileMounted)
    vi.useRealTimers()
  })

  it('stops the tunnel on click', async () => {
    getTunnelStatusMock.mockResolvedValue(RUNNING)
    const wrapper = await mountCard()
    await wrapper.find('.ghost-button').trigger('click')
    await flushPromises()
    expect(stopTunnelMock).toHaveBeenCalledTimes(1)
  })
})
