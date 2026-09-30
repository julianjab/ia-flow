/**
 * Lo que la bandeja lee de lo que pasó en el runner — ejecuciones, eventos y trazas —, en la forma
 * del wire (`@ia-flow/shared`). La implementa `SqliteActivity` sobre la base de ejecuciones; los
 * tests, con un fake.
 */
import type { EventLogEntry, ExecutionSummary, PipelineDecision, TraceEntry } from '@ia-flow/shared'

/** Un evento guardado con su payload: lo que se vuelve a despachar al reintentar. */
export interface StoredEvent {
  id: string
  type: string
  payload: unknown
  scope?: Record<string, unknown>
}

export interface ActivityPort {
  /** Las ejecuciones de una task (o todas las vivas), de la más nueva a la más vieja. */
  executions(query: {
    taskRef?: string
    statuses?: Array<ExecutionSummary['status']>
    limit?: number
  }): Array<ExecutionSummary & { key: string; task_ref?: string; project_id?: string }>
  /** Cuándo llegó el último evento de una task (ISO). */
  lastEventAt(taskRef: string): string | undefined
  eventsForTask(taskRef: string, limit: number): EventLogEntry[]
  /** Lo último que llegó al runner (de un proyecto, o de todos). */
  recentEvents(limit: number, projectId?: string): EventLogEntry[]
  trace(executionId: string, limit: number): TraceEntry[]
  /** El último evento de la task que el engine despachó, con su payload. */
  lastDispatchedEvent(taskRef: string): StoredEvent | undefined
}

/** El dry-run del engine: qué haría cada pipeline con un evento. */
export type ExplainPort = (event: StoredEvent) => Promise<PipelineDecision[]>

/** La task de una clave de ejecución: el scope que publica `resolve_task`, como pares. */
export function taskOfKey(key: string): { taskRef?: string; projectId?: string } {
  try {
    const pairs = JSON.parse(key) as Array<[string, unknown]>
    const value = (name: string) => {
      const found = pairs.find(([k]) => k === name)?.[1]
      return typeof found === 'string' ? found : undefined
    }
    const taskRef = value('issue')
    const projectId = value('projectId')
    return { ...(taskRef ? { taskRef } : {}), ...(projectId ? { projectId } : {}) }
  } catch {
    return {}
  }
}
