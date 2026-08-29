import type { RunMessage, Wait } from '@ia-flow/shared'

/**
 * Persistencia de esperas y de la cola de mensajes.
 *
 * Los dos van juntos porque son las dos caras del mismo problema —qué
 * sobrevive al final de un run— y sus consumidores son los mismos: el matcher
 * (que despierta) y el loop (que drena).
 */
export interface IWaitRepository {
  /** Las vivas de un proyecto. El filtrado fino (tipo de evento, task,
   *  condiciones) lo hace `matchWaits` en memoria: es puro y barato, y bajarlo
   *  a SQL partiría el criterio en dos lugares que se pueden desincronizar. */
  listByProject(projectId: string): Promise<Wait[]>

  /** Todas las vencidas, cruzando proyectos. Lo consume el barrido. */
  listExpired(now: string): Promise<Wait[]>

  /** La espera viva de una task, si tiene. El engine garantiza que hay a lo
   *  sumo una: dos serían un bug, y devolver la más reciente es preferible a
   *  fallar. */
  getByTask(taskId: string): Promise<Wait | null>

  create(wait: Wait): Promise<Wait>

  /** Borra y devuelve si existía. Es el "consumir": una espera que despertó no
   *  puede volver a hacerlo. */
  consume(id: string): Promise<boolean>

  // ── Cola de mensajes ──────────────────────────────────────────────────────

  enqueueMessage(message: RunMessage): Promise<RunMessage>

  /** Los pendientes de una task, en orden de llegada. */
  pendingMessages(taskId: string): Promise<RunMessage[]>

  /** Los marca consumidos. Se llama DESPUÉS de que el loop los incorporó, no
   *  antes: un run que muere entre el drenaje y el turno tiene que poder
   *  volver a leerlos. */
  markMessagesDelivered(ids: string[], runId: string): Promise<void>
}
