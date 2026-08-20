import { type WebhookProjectStatus, type WebhookStatus, WebhookStatusSchema } from '@ia-flow/shared'
import axios from 'axios'

export type { WebhookProjectStatus, WebhookStatus }

export async function getWebhookStatus(): Promise<WebhookStatus> {
  const { data } = await axios.get<unknown>('/api/webhooks/status')
  return WebhookStatusSchema.parse(data)
}
