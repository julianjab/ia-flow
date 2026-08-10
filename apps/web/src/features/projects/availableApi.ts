import type { AgentDefinition, SystemPromptDef } from '@ia-flow/shared'
import axios from 'axios'

// Overlay views: globals + this project's own rows, project shadowing globals
// when ids collide. Read-only — writes go through /api/project-config scoped
// to the appropriate target (project or global).

export async function fetchAvailableAgents(projectId: string): Promise<AgentDefinition[]> {
  const { data } = await axios.get<{ agents: AgentDefinition[] }>(
    `/api/projects/${projectId}/available-agents`,
  )
  return data.agents ?? []
}

export async function fetchAvailableSystemPrompts(projectId: string): Promise<SystemPromptDef[]> {
  const { data } = await axios.get<{ systemPrompts: SystemPromptDef[] }>(
    `/api/projects/${projectId}/available-system-prompts`,
  )
  return data.systemPrompts ?? []
}
