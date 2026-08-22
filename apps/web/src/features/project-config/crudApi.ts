import type { AgentDefinition, SystemPromptDef } from '@ia-flow/shared'
import axios from 'axios'

// Granular CRUD wrappers backed by /api/agents-crud and /api/system-prompts.
// Prefer these over the bulk /api/project-config PUT when the UI is editing a
// single item — bulk saves rewrite the entire scope and, when combined with
// the overlay read used in the project view, promote globals to project-owned
// rows.

export type Scope = { kind: 'project'; projectId: string } | { kind: 'global' }

function scopeQuery(scope: Scope): string {
  return scope.kind === 'global'
    ? '?scope=global'
    : `?projectId=${encodeURIComponent(scope.projectId)}`
}

// ─── Agents ────────────────────────────────────────────────────────────────

// `readOnly` reflects the repo backing this scope (YamlAgentRepository vs
// SqliteAgentRepository, see IAgentRepository.isReadOnly()) — it's the same
// value regardless of which scope you query, since a running server has
// exactly one agentRepo instance. Callers use this to gate write UI (add/
// edit/delete/reorder buttons) before the user hits a 400, not to decide
// what to render — the agents themselves still come from `inScope`/the
// overlay endpoints, this is purely a capability flag.
export async function fetchAgentsReadOnly(scope: Scope): Promise<boolean> {
  const { data } = await axios.get<{ readOnly: boolean }>(`/api/agents-crud${scopeQuery(scope)}`)
  return data.readOnly
}

export async function createAgent(scope: Scope, agent: AgentDefinition): Promise<AgentDefinition> {
  const { data } = await axios.post<{ agent: AgentDefinition }>(
    `/api/agents-crud${scopeQuery(scope)}`,
    agent,
  )
  return data.agent
}

export async function updateAgent(scope: Scope, agent: AgentDefinition): Promise<AgentDefinition> {
  const { data } = await axios.put<{ agent: AgentDefinition }>(
    `/api/agents-crud/${encodeURIComponent(agent.id)}${scopeQuery(scope)}`,
    agent,
  )
  return data.agent
}

export async function deleteAgent(scope: Scope, agentId: string): Promise<void> {
  await axios.delete(`/api/agents-crud/${encodeURIComponent(agentId)}${scopeQuery(scope)}`)
}

// Persists the evaluation order of the agent pipeline — the engine runs the
// first enabled agent (by `position`) whose project/repo/status/when all
// match. `ids` is the full ordered list of agent ids in the given scope.
export async function reorderAgents(scope: Scope, ids: string[]): Promise<void> {
  await axios.put(`/api/agents-crud/reorder${scopeQuery(scope)}`, { ids })
}

// ─── System prompts ────────────────────────────────────────────────────────

export async function createSystemPrompt(
  scope: Scope,
  prompt: SystemPromptDef,
): Promise<SystemPromptDef> {
  const { data } = await axios.post<{ systemPrompt: SystemPromptDef }>(
    `/api/system-prompts${scopeQuery(scope)}`,
    prompt,
  )
  return data.systemPrompt
}

export async function updateSystemPrompt(
  scope: Scope,
  prompt: SystemPromptDef,
): Promise<SystemPromptDef> {
  const { data } = await axios.put<{ systemPrompt: SystemPromptDef }>(
    `/api/system-prompts/${encodeURIComponent(prompt.id)}${scopeQuery(scope)}`,
    prompt,
  )
  return data.systemPrompt
}

export async function deleteSystemPrompt(scope: Scope, promptId: string): Promise<void> {
  await axios.delete(`/api/system-prompts/${encodeURIComponent(promptId)}${scopeQuery(scope)}`)
}
