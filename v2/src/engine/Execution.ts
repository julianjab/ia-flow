import type { RuleActionKind } from '../rules/actions/RuleActionEntry.js'

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface ExecutionMessage {
  body: string
  /** Tipo del DomainEvent que produjo este mensaje. */
  origin: string
  occurredAt: Date
  payload?: Record<string, unknown>
}

/**
 * Lo que un Do necesita para que su Execution pueda recibir mensajes
 * mientras sigue corriendo. Sólo tiene sentido para trabajo async de larga
 * vida — hoy sólo AgentAction (ver AgentRunEntity): un HttpAction/ScriptAction
 * ya terminó para cuando llegaría un segundo evento, así que ni siquiera
 * registran Execution.
 */
export interface ExecutionEntity {
  supportsAppend(): boolean
  appendMessage(message: ExecutionMessage): void
}

export interface ExecutionProps {
  id: string
  /** Rule.id que la generó. */
  pipelineId: string
  /** RuleActionEntry.id del `do` que la generó — obligatorio para matchear
   *  entre varios agentes corriendo sobre la misma task. */
  doId: string
  /** Task sobre la que corre, cuando el evento tiene scope a una. */
  taskId?: string
  kind: RuleActionKind
  entity: ExecutionEntity
  startedAt?: Date
}

/**
 * Instancia en vuelo de un Do. Vive mientras dure el trabajo que representa
 * y es lo que un evento nuevo matchea (por taskId) para decidir "esto le
 * habla a un run que ya está corriendo" en vez de reevaluar Pipelines desde
 * cero — ver ExecutionRegistry.tryAppend y Engine.dispatch. Generaliza el
 * `liveInject` puntual de AgentAction en v1 a un mecanismo de primera clase.
 */
export class Execution {
  readonly id: string
  readonly pipelineId: string
  readonly doId: string
  readonly taskId?: string
  readonly kind: RuleActionKind
  readonly entity: ExecutionEntity
  status: ExecutionStatus
  readonly startedAt: Date
  finishedAt?: Date

  constructor(props: ExecutionProps) {
    this.id = props.id
    this.pipelineId = props.pipelineId
    this.doId = props.doId
    this.taskId = props.taskId
    this.kind = props.kind
    this.entity = props.entity
    this.status = 'running'
    this.startedAt = props.startedAt ?? new Date()
  }

  isRunning(): boolean {
    return this.status === 'running'
  }

  /** Único criterio de match hoy: misma task y running. Un matcher más rico
   *  (por repo, por agentId, por doId específico) se agrega recién cuando
   *  aparezca un caso real que lo necesite — no antes. */
  matchesTask(taskId: string | undefined): boolean {
    throw new Error(
      'not implemented — this.isRunning() && this.taskId != null && this.taskId === taskId',
    )
  }

  /** false si no está running o la entidad no soporta append. Quien llama
   *  (ExecutionRegistry.tryAppend) interpreta false como "no matcheó nada",
   *  lo que deja seguir el flujo normal de Rules para ese evento. */
  append(message: ExecutionMessage): boolean {
    throw new Error(
      'not implemented — if (!this.isRunning() || !this.entity.supportsAppend()) return false; ' +
        'this.entity.appendMessage(message); return true',
    )
  }

  complete(): void {
    throw new Error('not implemented — this.status = "completed"; this.finishedAt = new Date()')
  }

  fail(): void {
    throw new Error('not implemented — this.status = "failed"; this.finishedAt = new Date()')
  }
}
