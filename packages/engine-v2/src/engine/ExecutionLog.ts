import type { AgentExit } from './Agent.js'
import type { WaitCondition } from './Execution.js'

export type ExecutionLogStatus = 'completed' | 'failed' | 'waiting'

export interface ExecutionLogProps {
  id: string
  /** Ausente cuando el run no tuvo un `payload` con `id` (un triage/
   *  normalizador que corrió directo sobre un evento) — se indexa bajo el
   *  bucket `''`. */
  taskId?: string
  agentId: string
  projectId?: string
  pipelineId?: string
  doId?: string
  outcome: string
  exit?: AgentExit
  status: ExecutionLogStatus
  summary?: string
  /** Mensaje de la falla capturada por Agent.run — explica POR QUÉ falló,
   *  no sólo que falló (ver Agent.finalize). */
  error?: string
  startedAt: Date
  finishedAt?: Date
  /** Presentes sólo cuando `status: 'waiting'` — lo que `Execution.fromLog`
   *  necesita para reconstruir la espera (ver Engine.dispatch). */
  waitUntil?: WaitCondition
  checkpoint?: unknown
}

/**
 * Historial PERSISTENTE de runs terminados — a diferencia de `Execution`
 * (que es sólo el estado EN VUELO y se descarta al `complete()`/`fail()`),
 * esto responde "¿qué pasó la última vez que este agente corrió sobre esta
 * task?". `Agent.finalize()` es quien la graba SIEMPRE, pase lo que pase
 * con el resto del cierre — perder esta fila deja al issue sin explicación
 * de por qué se movió a donde se movió.
 */
export class ExecutionLog {
  private static readonly byTaskId = new Map<string, ExecutionLog[]>()

  readonly id: string
  readonly taskId?: string
  readonly agentId: string
  readonly projectId?: string
  readonly pipelineId?: string
  readonly doId?: string
  readonly outcome: string
  readonly exit?: AgentExit
  readonly status: ExecutionLogStatus
  readonly summary?: string
  readonly error?: string
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly waitUntil?: WaitCondition
  readonly checkpoint?: unknown

  constructor(props: ExecutionLogProps) {
    this.id = props.id
    this.taskId = props.taskId
    this.agentId = props.agentId
    this.projectId = props.projectId
    this.pipelineId = props.pipelineId
    this.doId = props.doId
    this.outcome = props.outcome
    this.exit = props.exit
    this.status = props.status
    this.summary = props.summary
    this.error = props.error
    this.startedAt = props.startedAt
    this.finishedAt = props.finishedAt
    this.waitUntil = props.waitUntil
    this.checkpoint = props.checkpoint
  }

  static append(entry: ExecutionLog): void {
    const key = entry.taskId ?? ''
    const list = ExecutionLog.byTaskId.get(key) ?? []
    list.push(entry)
    ExecutionLog.byTaskId.set(key, list)
  }

  /** Orden cronológico — es lo que selectCommentWindow (v1) usa para cortar
   *  por recencia. `taskId` ausente/`''` lista los runs sin ese identificador. */
  static byTask(taskId?: string): ExecutionLog[] {
    return [...(ExecutionLog.byTaskId.get(taskId ?? '') ?? [])].sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
    )
  }

  /**
   * Saca UNA entrada por id — es lo que hace que despertar una espera sea
   * idempotente (mismo criterio que `waitRepo.consume` en v1: "el borrado ES
   * la clave de idempotencia"). Sin esto, dos eventos que matchean la misma
   * espera antes de que el primero termine de procesarse la despertarían
   * dos veces.
   */
  static consume(id: string): void {
    for (const list of ExecutionLog.byTaskId.values()) {
      const idx = list.findIndex((entry) => entry.id === id)
      if (idx !== -1) {
        list.splice(idx, 1)
        return
      }
    }
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    ExecutionLog.byTaskId.clear()
  }
}
