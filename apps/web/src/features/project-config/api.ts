import type { ProjectConfig } from '@ia-flow/shared'
import axios from 'axios'

export interface ProjectConfigResponse {
  config: ProjectConfig | null
  raw: string
}

// projectId is optional to keep single-project clients working during rollout;
// the server falls back to the default project when it's omitted.
export async function fetchProjectConfig(projectId?: string): Promise<ProjectConfigResponse> {
  const { data } = await axios.get<ProjectConfigResponse>('/api/project-config', {
    params: projectId ? { projectId } : undefined,
  })
  return data
}

export async function saveProjectConfig(config: ProjectConfig, projectId?: string): Promise<void> {
  await axios.put('/api/project-config', { config, projectId })
}

export async function saveProjectConfigRaw(raw: string, projectId?: string): Promise<void> {
  await axios.put('/api/project-config/raw', { raw, projectId })
}

export async function fetchTaskStatuses(): Promise<string[]> {
  const { data } = await axios.get<{ statuses: string[] }>('/api/tasks/statuses')
  return data.statuses
}
