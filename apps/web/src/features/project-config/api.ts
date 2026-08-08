import type { ProjectConfig } from '@ia-flow/shared'
import axios from 'axios'

export interface ProjectConfigResponse {
  config: ProjectConfig | null
  raw: string
}

type Scope = 'global' | undefined

// projectId is optional to keep single-project clients working during rollout;
// the server falls back to the default project when it's omitted. scope='global'
// targets rows where project_id IS NULL (takes precedence over projectId).
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

export async function saveProjectConfig(
  config: ProjectConfig,
  projectId?: string,
  scope?: Scope,
): Promise<void> {
  await axios.put('/api/project-config', { config, projectId, scope })
}

export async function saveProjectConfigRaw(
  raw: string,
  projectId?: string,
  scope?: Scope,
): Promise<void> {
  await axios.put('/api/project-config/raw', { raw, projectId, scope })
}

export async function fetchTaskStatuses(): Promise<string[]> {
  const { data } = await axios.get<{ statuses: string[] }>('/api/tasks/statuses')
  return data.statuses
}
