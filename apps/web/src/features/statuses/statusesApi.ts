import type { StatusConfig } from '@ia-flow/shared'
import axios from 'axios'

// Granular CRUD for status configs. Statuses are always project-scoped.

export async function createStatus(projectId: string, status: StatusConfig): Promise<StatusConfig> {
  const { data } = await axios.post<{ status: StatusConfig }>(
    `/api/statuses?projectId=${encodeURIComponent(projectId)}`,
    status,
  )
  return data.status
}

export async function updateStatus(projectId: string, status: StatusConfig): Promise<StatusConfig> {
  const { data } = await axios.put<{ status: StatusConfig }>(
    `/api/statuses/${encodeURIComponent(status.name)}?projectId=${encodeURIComponent(projectId)}`,
    status,
  )
  return data.status
}

export async function deleteStatus(projectId: string, name: string): Promise<void> {
  await axios.delete(
    `/api/statuses/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
  )
}
