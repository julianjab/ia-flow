import type { ExecutionEntity, ExecutionMessage } from './Execution.js'

/**
 * La entidad que un AgentAction cuelga de su Execution — el punto de anclaje
 * entre "hay un provider corriendo" y "le llegó un mensaje nuevo mientras
 * corría" (el `liveInject` puntual de v1, generalizado). Sólo acumula: el
 * drenado en el próximo turno del loop de tools es responsabilidad del
 * provider (ver Agent.execute), no de esta clase.
 */
export class AgentRunEntity implements ExecutionEntity {
  private readonly pending: ExecutionMessage[] = []

  supportsAppend(): boolean {
    return true
  }

  appendMessage(message: ExecutionMessage): void {
    throw new Error('not implemented — this.pending.push(message)')
  }

  /** El provider la llama antes de decidir el próximo turno del loop. */
  drain(): ExecutionMessage[] {
    throw new Error('not implemented — return this.pending.splice(0)')
  }
}
