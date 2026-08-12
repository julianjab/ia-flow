import type { ExecutionLog, ExecutionLogFilters } from '@ia-flow/shared'

export interface IExecutionLogRepository {
  insert(log: ExecutionLog): void
  update(id: string, patch: Partial<ExecutionLog>): void
  list(filters: ExecutionLogFilters): ExecutionLog[]
  getById(id: string): ExecutionLog | null
  /**
   * Close every row whose `finished_at` is still null — used at boot to
   * recover from a crash or restart mid-run. Returns the number of rows
   * that were rewritten so callers can log a heads-up.
   */
  sweepOrphaned(reason: string): number
}
