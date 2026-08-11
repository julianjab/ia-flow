import axios from 'axios'

// Client for /api/projects/:id/source/* — the provider-agnostic read side
// of a project. Callers don't care whether the underlying source is GitHub,
// Linear, local, etc. — that's what the server registry decides.

export interface StatusOption {
  name: string
  description?: string
}

export interface SourceItem {
  id: string
  title: string
  status: string
  repos?: string
  meta?: Record<string, unknown>
}

export interface StatusesResponse {
  kind: string
  statuses: StatusOption[]
  error?: string
}

export interface ItemsResponse {
  kind: string
  items: SourceItem[]
  error?: string
}

export interface SourceProjectField {
  name: string
  dataType: string
  options?: string[]
}

export interface FieldsResponse {
  kind: string
  fields: SourceProjectField[]
  error?: string
}

export async function fetchProjectFields(
  projectId: string,
  opts: { refresh?: boolean } = {},
): Promise<FieldsResponse> {
  const params = new URLSearchParams()
  if (opts.refresh) params.set('refresh', '1')
  const qs = params.toString()
  const { data } = await axios.get<FieldsResponse>(
    `/api/projects/${projectId}/source/fields${qs ? `?${qs}` : ''}`,
  )
  return data
}

export async function fetchProjectStatuses(
  projectId: string,
  opts: { refresh?: boolean } = {},
): Promise<StatusesResponse> {
  const params = new URLSearchParams()
  if (opts.refresh) params.set('refresh', '1')
  const qs = params.toString()
  const { data } = await axios.get<StatusesResponse>(
    `/api/projects/${projectId}/source/statuses${qs ? `?${qs}` : ''}`,
  )
  return data
}

export async function fetchProjectItems(
  projectId: string,
  opts: { status?: string; refresh?: boolean } = {},
): Promise<ItemsResponse> {
  const params = new URLSearchParams()
  if (opts.status) params.set('status', opts.status)
  if (opts.refresh) params.set('refresh', '1')
  const qs = params.toString()
  const { data } = await axios.get<ItemsResponse>(
    `/api/projects/${projectId}/source/items${qs ? `?${qs}` : ''}`,
  )
  return data
}

export async function setProjectItemField(
  projectId: string,
  itemId: string,
  field: string,
  value: string,
): Promise<void> {
  await axios.patch(
    `/api/projects/${projectId}/source/items/${itemId}/${encodeURIComponent(field)}`,
    { value },
  )
}

export interface SourceHealthField {
  name: string
  purpose: string
}

export interface SourceHealthResponse {
  kind: string
  ok: boolean
  missing: SourceHealthField[]
  warnings: SourceHealthField[]
  message?: string
  error?: string
}

export async function fetchProjectHealth(projectId: string): Promise<SourceHealthResponse> {
  const { data } = await axios.get<SourceHealthResponse>(`/api/projects/${projectId}/source/health`)
  return data
}
