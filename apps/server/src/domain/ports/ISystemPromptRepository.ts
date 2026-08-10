import type { SystemPromptDef } from '@ia-flow/shared'

// projectId semantics:
//   undefined → every row (admin/debug)
//   string    → rows scoped to that project only
//   null      → global rows only (project_id IS NULL)
export interface ISystemPromptRepository {
  getById(id: string): SystemPromptDef | null
  listByProject(projectId?: string | null): SystemPromptDef[]
  // Runtime overlay: project rows + globals, project shadowing globals on id collision.
  listForRuntime(projectId: string): SystemPromptDef[]
  upsert(sp: SystemPromptDef, position: number, projectId?: string | null): void
  deleteById(id: string): void
  deleteByProject(projectId: string | null): void
  seedIfMissing(sp: SystemPromptDef): void
}
