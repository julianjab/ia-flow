// Superset de `AgentAbortPort` (@ia-flow/agent-engine — lo que `Agent.run`
// escribe). Acá vive lo que además necesitan el barrido de retry y la ruta:
// listar, leer una fila y forzar un retry manual. Una sola implementación
// (`SqliteAgentAbortRepository`) satisface las dos interfaces.
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

export interface IAgentAbortRepository {
  recordAbort(input: {
    projectId: string
    taskId: string
    agentId: string
    runId?: string
    reason: string
    errorMsg?: string
  }): AgentAbortRecord
  resolveOpen(taskId: string, agentId: string): void
  /** Filas `pending` cuyo `nextRetryAt` ya venció — lo que consume el barrido. */
  listDue(atIso: string): AgentAbortRecord[]
  /** Filas sin resolver (`pending` + `exhausted`), más recientes primero —
   *  la lista que ve el operador. */
  list(projectId?: string): AgentAbortRecord[]
  get(id: string): AgentAbortRecord | null
  /** Limpia `nextRetryAt` sin tocar `status` — evita que el barrido vuelva a
   *  levantar la misma fila mientras un dispatch anterior sigue en vuelo
   *  (un retry puede tardar más que el intervalo del barrido). */
  markRetrying(id: string): void
}
