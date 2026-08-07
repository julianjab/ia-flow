import type { RepoMappingEntry } from '@ia-flow/shared'
import axios from 'axios'

export interface LocalRepo {
  name: string
  path: string
  type: string
  hasGit?: boolean
}

export interface LocalReposResponse {
  repos: LocalRepo[]
  error?: string
}

export interface DbRepoEntry {
  name: string
  path?: string
  githubOwner?: string
  githubRepo?: string
  workflow?: string
}

export async function getLocalRepos(): Promise<LocalReposResponse> {
  const { data } = await axios.get<LocalReposResponse>('/api/repos')
  return data
}

export async function getRepoMappings(): Promise<DbRepoEntry[]> {
  const { data } = await axios.get<{ mappings: DbRepoEntry[] }>('/api/repos/mappings')
  return data.mappings
}

export async function upsertRepoMapping(name: string, entry: RepoMappingEntry): Promise<void> {
  await axios.post('/api/repos/mappings', { name, ...entry })
}

export async function deleteRepoMapping(name: string): Promise<void> {
  await axios.delete(`/api/repos/mappings/${encodeURIComponent(name)}`)
}

export async function getScanRoots(): Promise<string[]> {
  const { data } = await axios.get<{ scanRoots: string[] }>('/api/repos/scan-roots')
  return data.scanRoots
}

export async function setScanRoots(scanRoots: string[]): Promise<void> {
  await axios.put('/api/repos/scan-roots', { scanRoots })
}
