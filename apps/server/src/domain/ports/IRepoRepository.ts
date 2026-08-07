import type { RepoMapping, RepoWorkflow } from '@ia-flow/shared'

export interface DbRepoEntry {
  name: string
  path?: string
  githubOwner?: string
  githubRepo?: string
  workflow?: RepoWorkflow
}

export interface IRepoRepository {
  list(): DbRepoEntry[]
  get(name: string): DbRepoEntry | null
  upsert(entry: DbRepoEntry): void
  delete(name: string): void
  bulkSet(mapping: RepoMapping): void
  toMapping(): RepoMapping
}
