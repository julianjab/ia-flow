import type { RunMessage } from '@ia-flow/shared'

/**
 * La cola de mensajes que entran a un run en curso.
 *
 * Separada de `IWaitRepository` aunque compartan la migración que las creó: sus
 * consumidores son distintos —el loop del agente drena, la ruta encola— y
 * ninguno de los dos usa la otra mitad.
 */
export interface IRunMessageRepository {
  enqueue(message: RunMessage): Promise<RunMessage>

  /** Los pendientes de una task, en orden de llegada. */
  pending(taskId: string): Promise<RunMessage[]>

  /** Los marca consumidos. Se llama DESPUÉS de que el loop los incorporó, no
   *  antes: un run que muere entre el drenaje y el turno tiene que poder
   *  volver a leerlos. */
  markDelivered(ids: string[], runId: string): Promise<void>
}
