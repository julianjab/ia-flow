import type { AgentExit } from './Agent.js'

export type ExecutionLogStatus = 'completed' | 'failed'

export interface ExecutionLogProps {
  id: string
  /** Ausente cuando el run no tuvo Task asociada (un triage/normalizador
   *  que corrió directo sobre un evento) — se indexa bajo el bucket `''`,
   *  mismo patrón que la memoria GLOBAL de AgentMemoryEntry. */
  taskId?: string
  agentId: string
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
  readonly pipelineId?: string
  readonly doId?: string
  readonly outcome: string
  readonly exit?: AgentExit
  readonly status: ExecutionLogStatus
  readonly summary?: string
  readonly error?: string
  readonly startedAt: Date
  readonly finishedAt?: Date

  constructor(props: ExecutionLogProps) {
    this.id = props.id
    this.taskId = props.taskId
    this.agentId = props.agentId
    this.pipelineId = props.pipelineId
    this.doId = props.doId
    this.outcome = props.outcome
    this.exit = props.exit
    this.status = props.status
    this.summary = props.summary
    this.error = props.error
    this.startedAt = props.startedAt
    this.finishedAt = props.finishedAt
  }

  static append(entry: ExecutionLog): void {
    const key = entry.taskId ?? ''
    const list = ExecutionLog.byTaskId.get(key) ?? []
    list.push(entry)
    ExecutionLog.byTaskId.set(key, list)
  }

  /** Orden cronológico — es lo que selectCommentWindow (v1) usa para cortar
   *  por recencia. `taskId` ausente/`''` lista los runs SIN Task asociada. */
  static byTask(taskId?: string): ExecutionLog[] {
    return [...(ExecutionLog.byTaskId.get(taskId ?? '') ?? [])].sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
    )
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    ExecutionLog.byTaskId.clear()
  }
}
