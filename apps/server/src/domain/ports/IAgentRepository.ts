import type { AgentDefinition } from '@ia-flow/shared'

// projectId semantics:
//   undefined → every row (admin/debug view)
//   string    → rows scoped to that project only
//   null      → global rows only (project_id IS NULL)
export interface IAgentRepository {
  listByProject(projectId?: string | null): AgentDefinition[]
  // Runtime overlay: project rows + globals, project shadowing globals on id
  // collision.
  listForRuntime(projectId: string): AgentDefinition[]
  upsert(agent: AgentDefinition, position: number, projectId?: string | null): void
  deleteById(id: string): void
  deleteByProject(projectId: string | null): void
}
