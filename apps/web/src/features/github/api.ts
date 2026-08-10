import axios from 'axios'

// Owner + repo discovery endpoints. Project items and metadata are per-project
// and live under /api/projects/:id/source/* (see features/projects/sourceApi).

export interface GithubOwner {
  login: string
  type: 'user' | 'org'
}

export interface OwnersResponse {
  owners: GithubOwner[]
  error?: string
}

export async function getOwners(refresh = false): Promise<OwnersResponse> {
  const { data } = await axios.get<OwnersResponse>(
    `/api/github/owners${refresh ? '?refresh=1' : ''}`,
  )
  return data
}

export interface ReposResponse {
  repos: string[]
  error?: string
}

export async function getRepos(owner: string, refresh = false): Promise<ReposResponse> {
  const params = new URLSearchParams({ owner })
  if (refresh) params.set('refresh', '1')
  const { data } = await axios.get<ReposResponse>(`/api/github/repos?${params.toString()}`)
  return data
}
