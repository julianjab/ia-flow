import type { Wait } from '@ia-flow/shared'

/**
 * Persistencia de esperas y pausas.
 *
 * Interfaz angosta: declara lo que sus dos consumidores necesitan —el matcher,
 * que despierta, y el barrido, que vence— y nada más.
 *
 * La cola de mensajes vive en `IRunMessageRepository`, aparte: comparten tabla
 * de origen (migración 060) pero no consumidor. El matcher nunca lee mensajes y
 * el loop del agente nunca lee esperas, así que juntarlas obligaría a cada uno
 * a depender de métodos que no usa.
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
   *  puede volver a hacerlo, y ese borrado ES la clave de idempotencia contra
   *  los reintentos de la fuente. */
  consume(id: string): Promise<boolean>
}
