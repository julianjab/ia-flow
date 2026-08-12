import type { ExecutionLog, ExecutionLogFilters } from '@ia-flow/shared'

export interface IExecutionLogRepository {
  insert(log: ExecutionLog): void
  update(id: string, patch: Partial<ExecutionLog>): void
  list(filters: ExecutionLogFilters): ExecutionLog[]
  getById(id: string): ExecutionLog | null
}
