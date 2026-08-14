import axios from 'axios'

export type TunnelState = 'stopped' | 'starting' | 'running' | 'error'

export interface TunnelStatus {
  state: TunnelState
  url: string | null
  webhookUrl: string | null
  startedAt: string | null
  error: string | null
  installed: boolean
  recentLog: string[]
}

export async function getTunnelStatus(): Promise<TunnelStatus> {
  const { data } = await axios.get<TunnelStatus>('/api/tunnel')
  return data
}

export async function startTunnel(): Promise<TunnelStatus> {
  // The server answers 500 when it can't even launch (binary missing) but the
  // body is still a TunnelStatus — surface it instead of throwing.
  const { data } = await axios.post<TunnelStatus>('/api/tunnel/start', null, {
    validateStatus: (s) => s < 600,
  })
  return data
}

export async function stopTunnel(): Promise<TunnelStatus> {
  const { data } = await axios.post<TunnelStatus>('/api/tunnel/stop')
  return data
}

// ─── Estado del daemon (modo por proyecto) ────────────────────────────────

export interface WebhookProjectStatus {
  projectId: string
  name: string
  mode: 'webhook' | 'polling'
  webhook: {
    lastEventAt: string | null
    lastReason: string | null
    lastScanAt: string | null
    fallbackIntervalMs: number
    /** false = todavía no llegó ningún delivery; el respaldo corre rápido. */
    deliveryReceived: boolean
  } | null
}

export interface WebhookStatus {
  defaultMode: 'webhook' | 'polling'
  secretConfigured: boolean
  endpoint: string
  projects: WebhookProjectStatus[]
}

export async function getWebhookStatus(): Promise<WebhookStatus> {
  const { data } = await axios.get<WebhookStatus>('/api/webhooks/status')
  return data
}
