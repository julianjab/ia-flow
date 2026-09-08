import {
  type AgentAbortRecord,
  AgentAbortRecordSchema,
  type RecoverableCheckpoint,
  RecoverableCheckpointSchema,
} from '@ia-flow/shared'
import axios from 'axios'

export type { AgentAbortRecord, RecoverableCheckpoint }

export interface RecoverableRuns {
  aborts: AgentAbortRecord[]
  checkpoints: RecoverableCheckpoint[]
}

/** Los dos orígenes de "runs recuperables": aborts sin resolver (`pending` +
 *  `exhausted`, con retry propio) y checkpoints resumibles que quedaron sin
 *  pasar por ahí (crash del server, o un truncado) — ver GET
 *  /api/agent-aborts. */
export async function listRecoverableRuns(projectId?: string): Promise<RecoverableRuns> {
  const { data } = await axios.get<{ aborts: unknown; checkpoints: unknown }>('/api/agent-aborts', {
    params: projectId ? { projectId } : undefined,
  })
  return {
    aborts: AgentAbortRecordSchema.array().parse(data.aborts),
    checkpoints: RecoverableCheckpointSchema.array().parse(data.checkpoints),
  }
}

/** Fuerza un retry ya, sin esperar el backoff del barrido automático. */
export async function retryAgentAbort(id: string): Promise<void> {
  await axios.post(`/api/agent-aborts/${encodeURIComponent(id)}/retry`)
}

/** Un checkpoint no tiene retry propio: se destraba re-emitiendo el status
 *  actual de la tarea, que es lo que hace que las reglas la vuelvan a tomar
 *  (mismo endpoint que usa Tareas → "Correr ahora"). */
export async function retryRecoverableCheckpoint(taskId: string, projectId: string): Promise<void> {
  await axios.post(`/api/tasks/${encodeURIComponent(taskId)}/run`, { projectId })
}
