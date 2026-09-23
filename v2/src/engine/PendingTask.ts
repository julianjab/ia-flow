export type DispatchOutcomeKind = 'dispatched' | 'skipped' | 'deferred'

/** `skipped` suelta el item (no matcheó nada, está bloqueado — reintentar no
 *  cambia el resultado). `deferred` lo devuelve al backlog para reintentar
 *  cuando se libere un slot, sin volver a pegarle a la fuente. */
export interface DispatchOutcome {
  kind: DispatchOutcomeKind
  reason?: string
}

export interface PendingTaskProps {
  /** Ausente para un run sin Task asociada (ver AgentSubject) — cuenta
   *  igual para los caps de agente/provider; sólo `runningForProject` la
   *  ignora (sin task no hay issue del proyecto que contar). */
  taskId?: string
  projectId?: string
  agentId: string
  providerId?: string
  /** Presente cuando este run es un sub-agente — un hijo corre sobre la
   *  MISMA task que su padre, así que se registra bajo una key propia (ver
   *  `key()`) para no pisar la entrada del padre. */
  parentRunId?: string
}

/**
 * Registro de runs en vuelo — de acá salen los conteos que
 * `Project.settings.maxConcurrentDispatches` y `Agent.maxConcurrentDispatches`
 * consultan antes de despachar. Una entrada se registra JUSTO ANTES de la
 * llamada al provider (nunca antes de pasar los demás gates), así un item
 * que esos gates rechazan nunca ocupa un slot.
 */
export class PendingTask {
  private static readonly entries = new Map<string, PendingTask>()

  readonly taskId?: string
  readonly projectId?: string
  readonly agentId: string
  readonly providerId?: string
  readonly parentRunId?: string

  constructor(props: PendingTaskProps) {
    this.taskId = props.taskId
    this.projectId = props.projectId
    this.agentId = props.agentId
    this.providerId = props.providerId
    this.parentRunId = props.parentRunId
  }

  /**
   * Clave de indexación — pública porque el llamador (AgentAction) la
   * necesita calcular IGUAL para `register` y para `remove`/`get` del mismo
   * run. `id` es lo que identifica esta unidad de capacidad: normalmente
   * `taskId`, o el id de la Execution cuando no hay Task (AgentSubject
   * ausente) — a PendingTask no le importa cuál de las dos es, sólo que sea
   * estable durante el run.
   */
  static key(id: string, runId?: string): string {
    return runId ? `${id}#sub:${runId}` : id
  }

  static register(id: string, entry: PendingTask): void {
    PendingTask.entries.set(id, entry)
  }

  static remove(id: string): void {
    PendingTask.entries.delete(id)
  }

  /** Un `get(id)` sin sufijo `#sub:` siempre resuelve al PADRE — es quien
   *  es dueño del ciclo de vida de la task. */
  static get(id: string): PendingTask | undefined {
    return PendingTask.entries.get(id)
  }

  /**
   * Cuenta runs del proyecto EXCLUYENDO sub-agentes (`parentRunId != null`)
   * — es el freno del deadlock: con el cap del proyecto en N, N padres
   * bloqueados esperando a sus hijos no deben agotar los N slots y dejar
   * que ningún hijo pueda arrancar nunca. Un sub-agente no es un issue
   * nuevo, es más trabajo sobre uno que ya está contado.
   */
  static runningForProject(projectId: string): number {
    return [...PendingTask.entries.values()].filter(
      (t) => t.projectId === projectId && t.parentRunId == null,
    ).length
  }

  /** Cruza proyectos a propósito — el cap de agente es del roster, no de un proyecto. */
  static runningForAgent(agentId: string): number {
    return [...PendingTask.entries.values()].filter((t) => t.agentId === agentId).length
  }

  static runningForProvider(providerId: string): number {
    return [...PendingTask.entries.values()].filter((t) => t.providerId === providerId).length
  }

  /** `0` o ausente = SIN LÍMITE — nunca "frenar todo": un cap que no puede
   *  despejarse dejaría el issue diferido para siempre. */
  static withinCap(running: number, cap: number | undefined): boolean {
    return cap == null || cap === 0 || running < cap
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    PendingTask.entries.clear()
  }
}
