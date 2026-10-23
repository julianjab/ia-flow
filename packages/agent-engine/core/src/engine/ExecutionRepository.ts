import type { DomainEvent } from '../events/DomainEvent.js'
import type { ExecutionJournal, ExecutionRecord } from './Execution.js'

/**
 * Dónde viven los datos de las ejecuciones. El `ExecutionStore` coordina (turnos, tope, pausas) y
 * le anota acá cada cambio; un repositorio persistente es lo que deja recuperar las pausas tras un
 * reinicio.
 *
 * Síncrono a propósito: el store marca la task ocupada en el mismo tick del `start`, y una
 * escritura asíncrona abriría una ventana en la que otra corrida la vería libre.
 */
export interface ExecutionRepository extends ExecutionJournal {
  /** Las ejecuciones que quedaron vivas (`running` o `paused`) — para recuperarlas al arrancar. */
  live(): ExecutionRecord[]
  /** Lo que se le entregó a `executionId` y nadie leyó. */
  unread(executionId: string): DomainEvent<any>[]
  /** Una corrida que espera turno o lugar bajo el tope, con el evento que la disparó: una espera
   *  vive en memoria, y sin esto un reinicio la perdía sin rastro. Opcional: sin él, igual que
   *  antes. */
  queued?(run: QueuedRun): void
  /** Su espera terminó: arrancó, la reemplazaron o cedió. */
  unqueued?(id: string): void
  /** Las que quedaron esperando cuando el proceso murió. */
  waiting?(): QueuedRun[]
}

/** Una corrida esperando turno (`ExecutionRepository.queued`). */
export interface QueuedRun {
  id: string
  key: string
  pipelineId: string
  /** ISO. */
  queuedAt: string
  event: DomainEvent<any>
}
