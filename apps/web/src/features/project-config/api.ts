import type { ProjectConfig, VariableDefinition } from '@ia-flow/shared'
import axios from 'axios'

export interface ProjectConfigResponse {
  config: ProjectConfig | null
  raw: string
}

type Scope = 'global' | undefined

// Read-only aggregate view. Writes go through the granular per-domain APIs
// (see crudApi.ts for agents/system prompts, statusesApi.ts for statuses,
// projectsApi.ts PATCH for project fields).
export async function fetchProjectConfig(
  projectId?: string,
  scope?: Scope,
): Promise<ProjectConfigResponse> {
  const params: Record<string, string> = {}
  if (scope) params.scope = scope
  else if (projectId) params.projectId = projectId
  const { data } = await axios.get<ProjectConfigResponse>('/api/project-config', {
    params: Object.keys(params).length ? params : undefined,
  })
  return data
}

export async function fetchTaskStatuses(): Promise<string[]> {
  const { data } = await axios.get<{ statuses: string[] }>('/api/tasks/statuses')
  return data.statuses
}

/**
 * Las variables de template disponibles para un contexto.
 *
 * Va por axios como todo el resto: el token del server elegido lo pone un
 * interceptor de axios (features/servers/selection.ts), así que un `fetch`
 * crudo sale sin credencial y el server responde 401.
 */
export async function fetchVariables(context: string): Promise<VariableDefinition[]> {
  const { data } = await axios.get<VariableDefinition[]>('/api/variables', {
    params: { context },
  })
  return data
}
