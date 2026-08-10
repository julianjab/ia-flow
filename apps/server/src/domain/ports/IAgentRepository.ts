import type { AgentDefinition } from '@ia-flow/shared'

export interface IAgentRepository {
  listAgents(): AgentDefinition[]
  upsertAgent(agent: AgentDefinition, position: number): void
  deleteAgent(id: string): void
  replaceAgents(agents: AgentDefinition[]): void
}
