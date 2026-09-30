import {
  type EventLogEntry,
  EventLogEntrySchema,
  type Ingress,
  IngressSchema,
} from '@ia-flow/shared'
import axios from 'axios'

/** Las entradas del runner (webhook de GitHub, Slack) y cuánto les llegó. */
export async function getIngress(): Promise<Ingress> {
  const { data } = await axios.get<unknown>('/api/ingress')
  return IngressSchema.parse(data)
}

/** Lo que llegó a una entrada, del más nuevo, con qué decidió cada pipeline. */
export async function getIngressEvents(id: string, limit = 50): Promise<EventLogEntry[]> {
  const { data } = await axios.get<unknown>(`/api/ingress/${encodeURIComponent(id)}/events`, {
    params: { limit },
  })
  return EventLogEntrySchema.array().parse(data)
}
