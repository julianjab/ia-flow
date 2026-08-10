import type { StatusConfig } from '@ia-flow/shared'

// Statuses are always project-scoped. `list()` with no projectId returns
// every row (admin/debug view); normal callers must scope by project.
export interface IStatusRepository {
  list(projectId?: string): StatusConfig[]
  upsert(status: StatusConfig, position: number, projectId: string): void
  deleteByProject(projectId: string): void
}
