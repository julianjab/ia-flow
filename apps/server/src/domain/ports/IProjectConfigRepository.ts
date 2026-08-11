import type { ProjectConfig } from '@ia-flow/shared'

// Read-only aggregate. Writes go through the granular per-domain endpoints
// (agents-crud, system-prompts, statuses, projects PATCH).
//
// scope semantics (mirror the db-layer helpers):
//   undefined → default project (back-compat single-tenant callers)
//   string    → that specific project — runtime overlay (project + globals)
//   null      → global rows only (project_id IS NULL); statuses are empty
//               since they always belong to a project
export interface IProjectConfigRepository {
  getConfig(scope?: string | null): Promise<ProjectConfig>
}
