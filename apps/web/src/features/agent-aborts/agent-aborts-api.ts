import { type AgentAbortRecord, AgentAbortRecordSchema } from '@ia-flow/shared'
import axios from 'axios'

export type { AgentAbortRecord }

/** Lista los aborts sin resolver (`pending` + `exhausted`), más recientes primero. */
export async function listAgentAborts(projectId?: string): Promise<AgentAbortRecord[]> {
  const { data } = await axios.get<{ aborts: unknown }>('/api/agent-aborts', {
    params: projectId ? { projectId } : undefined,
  })
  return AgentAbortRecordSchema.array().parse(data.aborts)
}

/** Fuerza un retry ya, sin esperar el backoff del barrido automático. */
export async function retryAgentAbort(id: string): Promise<void> {
  await axios.post(`/api/agent-aborts/${encodeURIComponent(id)}/retry`)
}
