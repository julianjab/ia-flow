import type { PipelineActionKind } from '../pipeline/actions/PipelineActionEntry.js'

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export type DispatchOutcomeKind = 'dispatched' | 'skipped' | 'deferred'

/** `skipped` suelta el item (no matcheó nada, está bloqueado — reintentar no
 *  cambia el resultado). `deferred` (ver Execution.withinCap) lo devuelve al
 *  backlog para reintentar cuando se libere un slot. */
export interface DispatchOutcome {
  kind: DispatchOutcomeKind
  reason?: string
}

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
  /** Pipeline.id que la generó. */
  pipelineId: string
  /** PipelineActionEntry.id del `do` que la generó — obligatorio para matchear
   *  entre varios agentes corriendo sobre la misma task. */
  doId: string
  /** Task sobre la que corre, cuando el evento tiene scope a una. */
  taskId?: string
  kind: PipelineActionKind
  entity: ExecutionEntity
  startedAt?: Date
  /** Los cuatro campos de acá abajo son lo que antes vivía en una clase
   *  `PendingTask` aparte, pensada para contar caps de concurrencia — se
   *  plegó acá porque nacía y moría en el MISMO instante que la Execution
   *  (se registraba justo antes de `new Execution(...)` y se borraba en el
   *  mismo `finally` que `complete()/fail()`): dos clases contando el mismo
   *  ciclo de vida. `runningForProject/Agent/Provider` reemplazan sus
   *  homónimos, filtrando sobre el índice que Execution ya mantiene. */
  agentId?: string
  projectId?: string
  providerId?: string
  /** Presente cuando este run es un sub-agente — excluido de
   *  `runningForProject` (ver ese método) para no producir deadlock. */
  parentRunId?: string
}

/**
 * Instancia en vuelo de un Do. Vive mientras dure el trabajo que representa
 * y es lo que un evento nuevo matchea (por taskId) para decidir "esto le
 * habla a un run que ya está corriendo" en vez de reevaluar Pipelines desde
 * cero — ver Engine.dispatch. Generaliza el `liveInject` puntual de
 * AgentAction en v1 a un mecanismo de primera clase.
 *
 * El índice por taskId vive ACÁ ADENTRO (estático) en vez de en una clase
 * `ExecutionRegistry` aparte: es sólo un `Map` + un `find`/`filter`, no
 * justifica una segunda clase de dominio para un objeto que ya sabe todo lo
 * necesario para indexarse a sí mismo (mismo criterio aplicado después a
 * `Project`, `PipelineActionEntry` y `Agent`). El costo consciente: dos Engine
 * en el mismo proceso (tests en paralelo) comparten este índice — se
 * resetea con `Execution.reset()`.
 */
export class Execution {
  private static readonly byTaskId = new Map<string, Execution[]>()

  readonly id: string
  readonly pipelineId: string
  readonly doId: string
  readonly taskId?: string
  readonly kind: PipelineActionKind
  readonly entity: ExecutionEntity
  status: ExecutionStatus
  readonly startedAt: Date
  finishedAt?: Date
  readonly agentId?: string
  readonly projectId?: string
  readonly providerId?: string
  readonly parentRunId?: string

  constructor(props: ExecutionProps) {
    this.id = props.id
    this.pipelineId = props.pipelineId
    this.doId = props.doId
    this.taskId = props.taskId
    this.kind = props.kind
    this.entity = props.entity
    this.status = 'running'
    this.startedAt = props.startedAt ?? new Date()
    this.agentId = props.agentId
    this.projectId = props.projectId
    this.providerId = props.providerId
    this.parentRunId = props.parentRunId
    Execution.index(this)
  }

  /** `taskId` ausente ⇒ bucket `''` (mismo patrón que ExecutionLog) — así
   *  una Execution sin task asociada (un agente que corrió sin `payload`)
   *  sigue entrando en `filter()`/`runningForAgent` en vez de perderse. */
  private static index(execution: Execution): void {
    const key = execution.taskId ?? ''
    const list = Execution.byTaskId.get(key) ?? []
    list.push(execution)
    Execution.byTaskId.set(key, list)
  }

  private static unindex(execution: Execution): void {
    const key = execution.taskId ?? ''
    const list = Execution.byTaskId.get(key)
    if (!list) return
    const idx = list.indexOf(execution)
    if (idx !== -1) list.splice(idx, 1)
  }

  /** Todas las Executions (cualquier status) de una task — base de findRunning/filter. */
  static byTask(taskId: string): Execution[] {
    return Execution.byTaskId.get(taskId) ?? []
  }

  /** Primera Execution running de esa task. */
  static findRunning(taskId: string | undefined): Execution | undefined {
    return taskId == null ? undefined : Execution.byTask(taskId).find((e) => e.isRunning())
  }

  /** Filtro genérico sobre TODAS las Executions indexadas, cualquier task —
   *  para necesidades futuras (ej. "todas las running de un pipelineId"). */
  static filter(predicate: (execution: Execution) => boolean): Execution[] {
    return [...Execution.byTaskId.values()].flat().filter(predicate)
  }

  /** true si encontró una Execution running de esa task y el append pegó —
   *  Engine.dispatch corta ahí y NO reevalúa Pipelines para este evento. */
  static tryAppend(taskId: string | undefined, message: ExecutionMessage): boolean {
    const exec = Execution.findRunning(taskId)
    return exec != null && exec.append(message)
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    Execution.byTaskId.clear()
  }

  /**
   * Cuenta Executions running del proyecto EXCLUYENDO sub-agentes
   * (`parentRunId != null`) — freno anti-deadlock: con el cap del proyecto
   * en N, N padres bloqueados esperando a sus hijos no deben agotar los N
   * slots y dejar que ningún hijo pueda arrancar nunca. Un sub-agente no es
   * un issue nuevo, es más trabajo sobre uno que ya está contado.
   */
  static runningForProject(projectId: string): number {
    return Execution.filter(
      (e) => e.isRunning() && e.projectId === projectId && e.parentRunId == null,
    ).length
  }

  /** Cruza proyectos a propósito — el cap de agente es del roster, no de un proyecto. */
  static runningForAgent(agentId: string): number {
    return Execution.filter((e) => e.isRunning() && e.agentId === agentId).length
  }

  static runningForProvider(providerId: string): number {
    return Execution.filter((e) => e.isRunning() && e.providerId === providerId).length
  }

  /** `0` o ausente = SIN LÍMITE — nunca "frenar todo": un cap que no puede
   *  despejarse dejaría el issue diferido para siempre. */
  static withinCap(running: number, cap: number | undefined): boolean {
    return cap == null || cap === 0 || running < cap
  }

  isRunning(): boolean {
    return this.status === 'running'
  }

  /** Único criterio de match hoy: misma task y running. Un matcher más rico
   *  (por repo, por agentId, por doId específico) se agrega recién cuando
   *  aparezca un caso real que lo necesite — no antes. */
  matchesTask(taskId: string | undefined): boolean {
    return this.isRunning() && this.taskId != null && this.taskId === taskId
  }

  /** false si no está running o la entidad no soporta append. Quien llama
   *  (Execution.tryAppend) interpreta false como "no matcheó nada", lo que
   *  deja seguir el flujo normal de Pipelines para ese evento. */
  append(message: ExecutionMessage): boolean {
    if (!this.isRunning() || !this.entity.supportsAppend()) return false
    this.entity.appendMessage(message)
    return true
  }

  complete(): void {
    this.status = 'completed'
    this.finishedAt = new Date()
    Execution.unindex(this)
  }

  fail(): void {
    this.status = 'failed'
    this.finishedAt = new Date()
    Execution.unindex(this)
  }
}
