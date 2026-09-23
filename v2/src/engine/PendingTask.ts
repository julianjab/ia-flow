export type DispatchOutcomeKind = 'dispatched' | 'skipped' | 'deferred'

/** `skipped` suelta el item (no matcheó nada, está bloqueado — reintentar no
 *  cambia el resultado). `deferred` lo devuelve al backlog para reintentar
 *  cuando se libere un slot, sin volver a pegarle a la fuente. */
export interface DispatchOutcome {
  kind: DispatchOutcomeKind
  reason?: string
}

export interface PendingTaskProps {
  taskId: string
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

  readonly taskId: string
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

  private static key(taskId: string, runId?: string): string {
    return runId ? `${taskId}#sub:${runId}` : taskId
  }

  static register(task: PendingTask, runId?: string): void {
    throw new Error(
      'not implemented — PendingTask.entries.set(PendingTask.key(task.taskId, runId), task)',
    )
  }

  static remove(taskId: string, runId?: string): void {
    throw new Error('not implemented — PendingTask.entries.delete(PendingTask.key(taskId, runId))')
  }

  /** Un `getPendingTask(taskId)` sin `runId` (sin sufijo) siempre resuelve
   *  al PADRE — es quien es dueño del ciclo de vida de la task. */
  static get(taskId: string): PendingTask | undefined {
    throw new Error('not implemented — PendingTask.entries.get(PendingTask.key(taskId))')
  }

  /**
   * Cuenta runs del proyecto EXCLUYENDO sub-agentes (`parentRunId != null`)
   * — es el freno del deadlock: con el cap del proyecto en N, N padres
   * bloqueados esperando a sus hijos no deben agotar los N slots y dejar
   * que ningún hijo pueda arrancar nunca. Un sub-agente no es un issue
   * nuevo, es más trabajo sobre uno que ya está contado.
   */
  static runningForProject(projectId: string): number {
    throw new Error(
      'not implemented — [...PendingTask.entries.values()].filter(t => t.projectId === projectId && ' +
        't.parentRunId == null).length',
    )
  }

  /** Cruza proyectos a propósito — el cap de agente es del roster, no de un proyecto. */
  static runningForAgent(agentId: string): number {
    throw new Error(
      'not implemented — [...PendingTask.entries.values()].filter(t => t.agentId === agentId).length',
    )
  }

  static runningForProvider(providerId: string): number {
    throw new Error(
      'not implemented — [...PendingTask.entries.values()].filter(t => t.providerId === providerId).length',
    )
  }

  /** `0` o ausente = SIN LÍMITE — nunca "frenar todo": un cap que no puede
   *  despejarse dejaría el issue diferido para siempre. */
  static withinCap(running: number, cap: number | undefined): boolean {
    throw new Error('not implemented — cap == null || cap === 0 || running < cap')
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    throw new Error('not implemented — PendingTask.entries.clear()')
  }
}
