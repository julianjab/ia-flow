import type { Project, SourceRef } from '@ia-flow/shared'
import axios from 'axios'

export async function fetchProjects(includeArchived = false): Promise<Project[]> {
  const { data } = await axios.get<{ projects: Project[] }>('/api/projects', {
    params: { includeArchived: includeArchived || undefined },
  })
  return data.projects ?? []
}

export async function fetchProject(id: string): Promise<Project> {
  const { data } = await axios.get<{ project: Project }>(`/api/projects/${id}`)
  return data.project
}

export async function createProject(input: {
  id: string
  name: string
  source?: SourceRef
  settings?: Record<string, unknown>
}): Promise<Project> {
  const { data } = await axios.post<{ project: Project }>('/api/projects', input)
  return data.project
}

export async function patchProject(
  id: string,
  patch: {
    name?: string
    // undefined leaves it unchanged; null clears; object replaces.
    source?: SourceRef | null
    settings?: Record<string, unknown>
  },
): Promise<Project> {
  const { data } = await axios.patch<{ project: Project }>(`/api/projects/${id}`, patch)
  return data.project
}

export async function archiveProject(id: string): Promise<void> {
  await axios.delete(`/api/projects/${id}`)
}

// Counts the rows that would be removed by a cascade delete. Powers the
// preview in the confirmation dialog so the user knows what they're losing.
export interface CascadePreview {
  agents: number
  systemPrompts: number
  statuses: number
}

export async function fetchCascadePreview(id: string): Promise<CascadePreview> {
  const { data } = await axios.get<CascadePreview>(`/api/projects/${id}/cascade-preview`)
  return data
}

// Hard delete — the project and every row it owns (agents, system prompts,
// statuses scoped to this project). Globals are untouched.
export async function deleteProjectCascade(id: string): Promise<void> {
  await axios.delete(`/api/projects/${id}`, { params: { cascade: 'true' } })
}

// ─── Polling pause (in-memory, per-project) ────────────────────────────────
// Backend: packages/issue-sources/src/dispatch/polling-pause.ts. Not persisted:
// a daemon restart resumes every project.
export interface PollingStatus {
  projectId: string
  paused: boolean
}

export async function fetchPollingStatus(id: string): Promise<PollingStatus> {
  const { data } = await axios.get<PollingStatus>(`/api/projects/${id}/polling`)
  return data
}

export async function pausePolling(id: string): Promise<PollingStatus> {
  const { data } = await axios.post<PollingStatus>(`/api/projects/${id}/polling/pause`)
  return data
}

export async function resumePolling(id: string): Promise<PollingStatus> {
  const { data } = await axios.post<PollingStatus>(`/api/projects/${id}/polling/resume`)
  return data
}
