import type { StatusConfig } from '@ia-flow/shared'

// Statuses are always project-scoped. `list()` with no projectId returns
// every row (admin/debug view); normal callers must scope by project.
export interface IStatusRepository {
  list(projectId?: string): StatusConfig[]
  getByName(projectId: string, name: string): StatusConfig | null
  upsert(status: StatusConfig, position: number, projectId: string): void
  deleteByName(projectId: string, name: string): void
  clearScope(projectId: string): void
}
