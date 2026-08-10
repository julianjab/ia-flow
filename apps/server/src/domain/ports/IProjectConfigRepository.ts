import type { ProjectConfig } from '@ia-flow/shared'

// projectId semantics:
//   undefined → default project (first non-archived) — legacy single-tenant
//               callers keep working
//   string    → agents/prompts = overlay of that project's own + globals
//               (runtime resolution); statuses = strictly that project's rows.
export interface IProjectConfigRepository {
  getConfig(projectId?: string): Promise<ProjectConfig>
  saveConfig(config: ProjectConfig, projectId?: string): Promise<void>
}
