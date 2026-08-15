import type { AgentDefinition } from '@ia-flow/shared'

// projectId semantics:
//   undefined → every row (admin/debug view)
//   string    → rows scoped to that project only
//   null      → global rows only (project_id IS NULL)
export interface IAgentRepository {
  inScope(projectId?: string | null): AgentDefinition[]
  // Runtime overlay: project rows + globals, project shadowing globals on id
  // collision.
  visibleTo(projectId: string): AgentDefinition[]
  upsert(agent: AgentDefinition, position: number, projectId?: string | null): void
  deleteById(id: string): void
  clearScope(projectId: string | null): void
  // Persists `position = index in ids` for every id, scoped the same way as
  // `inScope`/`clearScope` (`null` = global rows, string = that project's
  // rows). Ids outside the scope are ignored. Used by the reorder endpoint
  // so the engine's "first agent that matches, by position" tie-break is
  // user-controlled instead of insertion order.
  setPositions(ids: string[], projectId: string | null): void
}
