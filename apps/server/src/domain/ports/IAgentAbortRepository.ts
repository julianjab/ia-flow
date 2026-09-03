// Superset de `AgentAbortPort` (@ia-flow/agent-engine — lo que `Agent.run`
// escribe). Acá vive lo que además necesitan el barrido de retry y la ruta:
// listar, leer una fila y forzar un retry manual. Una sola implementación
// (`SqliteAgentAbortRepository`) satisface las dos interfaces.
//
// El shape del registro cruza la red (GET/POST /api/agent-aborts, que la web
// consume) así que vive en @ia-flow/shared y se reusa acá — no se duplica a
// mano como hacía `ProviderRegistration`.
import type { AgentAbortRecord } from '@ia-flow/shared'

export type { AgentAbortRecord }

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
  /** Filas `pending` con `nextRetryAt` en null (o sea, tomadas por
   *  `markRetrying`) hace más de `staleBeforeIso` — el dispatch que las tomó
   *  nunca volvió a tocarlas (cancelado sin pasar por `resolveOpen`/
   *  `recordAbort`, o el proceso murió a mitad del run). Las trata como un
   *  intento fallido más, con el mismo backoff acotado — sin esto quedan
   *  huérfanas para siempre. */
  reconcileStale(staleBeforeIso: string): void
}
