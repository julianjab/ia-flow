import axios from 'axios'

// Mirrors AgentAbortRecord en apps/server/src/domain/ports/IAgentAbortRepository.ts.
export interface AgentAbortRecord {
  id: string
  projectId: string
  taskId: string
  agentId: string
  runId: string | null
  reason: string
  errorMsg: string | null
  attempts: number
  maxAttempts: number
  status: 'pending' | 'exhausted' | 'resolved'
  nextRetryAt: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

/** Lista los aborts sin resolver (`pending` + `exhausted`), más recientes primero. */
export async function listAgentAborts(projectId?: string): Promise<AgentAbortRecord[]> {
  const { data } = await axios.get<{ aborts: AgentAbortRecord[] }>('/api/agent-aborts', {
    params: projectId ? { projectId } : undefined,
  })
  return data.aborts
}

/** Fuerza un retry ya, sin esperar el backoff del barrido automático. */
export async function retryAgentAbort(id: string): Promise<void> {
  await axios.post(`/api/agent-aborts/${encodeURIComponent(id)}/retry`)
}
