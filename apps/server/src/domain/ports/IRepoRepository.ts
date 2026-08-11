import type { RepoMapping, RepoWorkflow } from '@ia-flow/shared'

// A repo row as it lives in SQLite. `projectId` is required — every repo
// belongs to exactly one project since migration 011.
export interface DbRepoEntry {
  name: string
  projectId: string
  path?: string
  githubOwner?: string
  githubRepo?: string
  workflow?: RepoWorkflow
  description?: string
}

export interface IRepoRepository {
  // ─── project-scoped CRUD ───────────────────────────────────────────────
  listByProject(projectId: string): DbRepoEntry[]
  getByProject(name: string, projectId: string): DbRepoEntry | null
  upsert(entry: DbRepoEntry): void
  deleteByProject(name: string, projectId: string): void

  // ─── internal lookups (name-only) ──────────────────────────────────────
  // Used by resolveGithubRepo / getRepoPaths / getRepoWorkflow, which
  // historically took a bare `name`. With repos now scoped per-project this
  // just returns the first matching row (names are unique per project but
  // may repeat across projects). Callers with a projectId should prefer
  // `getByProject`.
  list(): DbRepoEntry[]
  get(name: string): DbRepoEntry | null

  // ─── cross-project lookups (for `/api/repos/lookup`) ──────────────────
  findByGithubRepo(owner: string, repo: string): DbRepoEntry[]
  findByPath(path: string): DbRepoEntry[]

  // ─── legacy provider-config bridge ─────────────────────────────────────
  // Both operate against a single target project. `bulkSet` REPLACES the
  // target project's repos (upsert-only, no delete elsewhere).
  bulkSet(mapping: RepoMapping, projectId: string): void
  toMapping(projectId: string): RepoMapping
}
