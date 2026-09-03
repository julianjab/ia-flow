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
  /** Reprograma un retry corto SIN quemar `attempts` — para cuando el
   *  dispatch devolvió `deferred` (cap de proyecto/agente/provider, lock de
   *  la task tomado): no es un fallo del agente, es "todavía no había
   *  lugar". Acotado por edad (`MAX_DEFER_AGE_MS`): pasado ese punto marca
   *  `exhausted` en vez de reintentar para siempre. */
  deferRetry(id: string): void
  /** Filas `pending` con `nextRetryAt` en null (o sea, tomadas por
   *  `markRetrying`) hace más de `staleBeforeIso` — de sólo lectura porque el
   *  repo no sabe si el dispatch que las tomó sigue vivo o no: el caller
   *  (`daemon.ts`) las cruza contra el registro de runs en vuelo antes de
   *  decidir qué hacer con cada una. */
  listStaleRetrying(staleBeforeIso: string): AgentAbortRecord[]
  /** El intento contra una fila ya abierta no llegó a un cierre limpio —
   *  mismo backoff acotado que un abort real (`recordAbort`), para cuando el
   *  dispatch ni corrió el agente (`skipped`, fallo de infra al despachar)
   *  o una fila de `listStaleRetrying` resultó genuinamente huérfana. */
  recordFailedAttempt(id: string, errorMsg: string): void
}
