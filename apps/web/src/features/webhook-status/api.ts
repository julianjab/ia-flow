import axios from 'axios'

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
