import { type ConfigSummary, ConfigSummarySchema } from '@ia-flow/shared'
import axios from 'axios'

/** La config que el runner tiene cargada, en corto y sin secretos (`GET /api/config`). */
export async function getConfig(): Promise<ConfigSummary> {
  const { data } = await axios.get<unknown>('/api/config')
  return ConfigSummarySchema.parse(data)
}
