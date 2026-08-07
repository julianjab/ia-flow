import type { AgentDefinition, SystemPromptDef } from '@ia-flow/shared'

export interface IAgentRepository {
  listAgents(): AgentDefinition[]
  upsertAgent(agent: AgentDefinition, position: number): void
  deleteAgent(id: string): void
  replaceAgents(agents: AgentDefinition[]): void
  listSystemPrompts(): SystemPromptDef[]
  upsertSystemPrompt(sp: SystemPromptDef, position: number): void
  deleteSystemPrompt(id: string): void
  replaceSystemPrompts(prompts: SystemPromptDef[]): void
  seedSystemPromptIfMissing(sp: SystemPromptDef): void
}
