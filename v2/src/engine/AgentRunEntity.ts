import type { ExecutionEntity, ExecutionMessage } from './Execution.js'

/**
 * La entidad que un AgentAction cuelga de su Execution — el punto de anclaje
 * entre "hay un provider corriendo" y "le llegó un mensaje nuevo mientras
 * corría" (el `liveInject` puntual de v1, generalizado). El drenado en el
 * próximo turno del loop de tools es responsabilidad del provider (ver
 * Agent.execute), no de esta clase.
 *
 * También carga lo que en v1 era un `RunCheckpoint` aparte: el último
 * `state` que el provider mandó, para retomar el turno siguiente sin
 * rearmar la conversación desde cero. No es una clase separada porque acá
 * vive en el mismo objeto que YA representa "el estado de ESTA corrida" —
 * separarlo sólo tendría sentido si necesitara sobrevivir a un reinicio del
 * proceso (v1 lo persistía en disco para reanudar tras un crash), pero
 * `AgentRunEntity` es en-memoria como el resto de este esqueleto: si el
 * proceso muere, se pierde junto con su `Execution`. Lo que sí resuelve
 * dentro del MISMO proceso es un pause/resume del loop sin perder el último
 * request enviado.
 */
export class AgentRunEntity implements ExecutionEntity {
  private readonly pending: ExecutionMessage[] = []

  /** Opaco para el engine — lo decide el provider (mismo canal que
   *  WorkspacePlan/AdmissionRequest). anthropic-api guarda ahí su array de
   *  mensajes; un provider de terminal no necesita usar esto. */
  state?: unknown
  updatedAt?: Date

  supportsAppend(): boolean {
    return true
  }

  appendMessage(message: ExecutionMessage): void {
    this.pending.push(message)
  }

  /** El provider la llama antes de decidir el próximo turno del loop. */
  drain(): ExecutionMessage[] {
    return this.pending.splice(0)
  }

  /** Se guarda DESPUÉS de compactar y ANTES del request — lo persistido es
   *  exactamente lo que se mandó, así un fallo del request no deja un
   *  checkpoint mintiendo sobre qué se envió. */
  save(state: unknown): void {
    this.state = state
    this.updatedAt = new Date()
  }
}
