import type { Database } from 'bun:sqlite'
import type { RepoMapping, RepoMappingEntry, RepoWorkflow } from '@ia-flow/shared'
import type { DbRepoEntry, IRepoRepository } from '../../../domain/ports/IRepoRepository.js'

export class SqliteRepoRepository implements IRepoRepository {
  constructor(private db: Database) {}

  // ─── project-scoped ─────────────────────────────────────────────────────
  listByProject(projectId: string): DbRepoEntry[] {
    const rows = this.db
      .query('SELECT * FROM repos WHERE project_id = ? ORDER BY name')
      .all(projectId) as Record<string, unknown>[]
    return rows.map(this.rowToEntry)
  }

  getByProject(name: string, projectId: string): DbRepoEntry | null {
    const row = this.db
      .query('SELECT * FROM repos WHERE name = ? AND project_id = ?')
      .get(name, projectId) as Record<string, unknown> | null
    return row ? this.rowToEntry(row) : null
  }

  upsert(entry: DbRepoEntry): void {
    this.db.run(
      `INSERT INTO repos (name, path, github_owner, github_repo, workflow, description, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, project_id) DO UPDATE SET
         path         = excluded.path,
         github_owner = excluded.github_owner,
         github_repo  = excluded.github_repo,
         workflow     = excluded.workflow,
         description  = excluded.description`,
      [
        entry.name,
        entry.path ?? null,
        entry.githubOwner ?? null,
        entry.githubRepo ?? null,
        entry.workflow ?? null,
        entry.description ?? null,
        entry.projectId,
      ],
    )
  }

  deleteByProject(name: string, projectId: string): void {
    this.db.run('DELETE FROM repos WHERE name = ? AND project_id = ?', [name, projectId])
  }

  // ─── name-only lookups (legacy path) ────────────────────────────────────
  // Names are unique per project but may repeat across projects. We return
  // the first row so existing callers (resolveGithubRepo, getRepoPaths,
  // getRepoWorkflow) keep working. Prefer `getByProject` when you know it.
  list(): DbRepoEntry[] {
    const rows = this.db.query('SELECT * FROM repos ORDER BY name').all() as Record<
      string,
      unknown
    >[]
    return rows.map(this.rowToEntry)
  }

  get(name: string): DbRepoEntry | null {
    const row = this.db.query('SELECT * FROM repos WHERE name = ? LIMIT 1').get(name) as Record<
      string,
      unknown
    > | null
    return row ? this.rowToEntry(row) : null
  }

  // ─── cross-project lookups ─────────────────────────────────────────────
  findByGithubRepo(owner: string, repo: string): DbRepoEntry[] {
    const rows = this.db
      .query('SELECT * FROM repos WHERE github_owner = ? AND github_repo = ?')
      .all(owner, repo) as Record<string, unknown>[]
    return rows.map(this.rowToEntry)
  }

  findByPath(path: string): DbRepoEntry[] {
    const rows = this.db.query('SELECT * FROM repos WHERE path = ?').all(path) as Record<
      string,
      unknown
    >[]
    return rows.map(this.rowToEntry)
  }

  // ─── legacy provider-config bridge ─────────────────────────────────────
  bulkSet(mapping: RepoMapping, projectId: string): void {
    this.db.transaction(() => {
      for (const [name, value] of Object.entries(mapping)) {
        if (typeof value === 'string') {
          this.upsert({ name, projectId, githubRepo: value })
        } else if (value && typeof value === 'object') {
          const v = value as RepoMappingEntry
          this.upsert({
            name,
            projectId,
            path: v.path,
            githubOwner: v.githubOwner,
            githubRepo: v.githubRepo,
            workflow: v.workflow,
            description: v.description,
          })
        }
      }
    })()
  }

  toMapping(projectId: string): RepoMapping {
    const entries = this.listByProject(projectId)
    return Object.fromEntries(
      entries.map(({ name, projectId: _pid, ...rest }) => [name, rest as RepoMappingEntry]),
    )
  }

  private rowToEntry(row: Record<string, unknown>): DbRepoEntry {
    const entry: DbRepoEntry = {
      name: row.name as string,
      projectId: row.project_id as string,
    }
    if (row.path) entry.path = row.path as string
    if (row.github_owner) entry.githubOwner = row.github_owner as string
    if (row.github_repo) entry.githubRepo = row.github_repo as string
    if (row.workflow) entry.workflow = row.workflow as RepoWorkflow
    if (row.description) entry.description = row.description as string
    return entry
  }
}
