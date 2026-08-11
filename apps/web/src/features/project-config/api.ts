import type { ProjectConfig } from '@ia-flow/shared'
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
