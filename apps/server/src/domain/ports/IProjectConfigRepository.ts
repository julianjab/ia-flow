import type { ProjectConfig } from '@ia-flow/shared'

// scope semantics (mirror the db-layer helpers):
//   undefined → default project (back-compat single-tenant callers)
//   string    → that specific project's own rows (strict) for save; runtime
//               overlay (project + globals) for get
//   null      → global rows only (project_id IS NULL); statuses are empty
//               since they always belong to a project
export interface IProjectConfigRepository {
  getConfig(scope?: string | null): Promise<ProjectConfig>
  saveConfig(config: ProjectConfig, scope?: string | null): Promise<void>
}
