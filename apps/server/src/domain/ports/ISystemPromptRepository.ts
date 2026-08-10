import type { SystemPromptDef } from '@ia-flow/shared'

// projectId semantics:
//   undefined → every row (admin/debug)
//   string    → rows scoped to that project only
//   null      → global rows only (project_id IS NULL)
export interface ISystemPromptRepository {
  getById(id: string): SystemPromptDef | null
  inScope(projectId?: string | null): SystemPromptDef[]
  // Runtime overlay: project rows + globals, project shadowing globals on id collision.
  visibleTo(projectId: string): SystemPromptDef[]
  upsert(sp: SystemPromptDef, position: number, projectId?: string | null): void
  deleteById(id: string): void
  clearScope(projectId: string | null): void
}
