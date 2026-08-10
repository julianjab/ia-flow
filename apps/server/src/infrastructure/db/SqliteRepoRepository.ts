import type { Database } from 'bun:sqlite'
import type { RepoMapping, RepoMappingEntry, RepoWorkflow } from '@ia-flow/shared'
import type { DbRepoEntry, IRepoRepository } from '../../domain/ports/IRepoRepository.js'

export class SqliteRepoRepository implements IRepoRepository {
  constructor(private db: Database) {}

  list(): DbRepoEntry[] {
    const rows = this.db.query('SELECT * FROM repos ORDER BY name').all() as Record<
      string,
      unknown
    >[]
    return rows.map(this.rowToEntry)
  }

  get(name: string): DbRepoEntry | null {
    const row = this.db.query('SELECT * FROM repos WHERE name = ?').get(name) as Record<
      string,
      unknown
    > | null
    return row ? this.rowToEntry(row) : null
  }

  upsert(entry: DbRepoEntry): void {
    this.db.run(
      `INSERT INTO repos (name, path, github_owner, github_repo, workflow)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         path         = excluded.path,
         github_owner = excluded.github_owner,
         github_repo  = excluded.github_repo,
         workflow     = excluded.workflow`,
      [
        entry.name,
        entry.path ?? null,
        entry.githubOwner ?? null,
        entry.githubRepo ?? null,
        entry.workflow ?? null,
      ],
    )
  }

  delete(name: string): void {
    this.db.run('DELETE FROM repos WHERE name = ?', [name])
  }

  // Upsert-only: never wipes the table. See db.ts::bulkSetRepos for the
  // history behind this — previously used `DELETE FROM repos` and could clear
  // the whole table on an empty payload.
  bulkSet(mapping: RepoMapping): void {
    this.db.transaction(() => {
      for (const [name, value] of Object.entries(mapping)) {
        if (typeof value === 'string') {
          this.upsert({ name, githubRepo: value })
        } else if (value && typeof value === 'object') {
          const v = value as RepoMappingEntry
          this.upsert({
            name,
            path: v.path,
            githubOwner: v.githubOwner,
            githubRepo: v.githubRepo,
            workflow: v.workflow,
          })
        }
      }
    })()
  }

  toMapping(): RepoMapping {
    const entries = this.list()
    return Object.fromEntries(entries.map(({ name, ...rest }) => [name, rest as RepoMappingEntry]))
  }

  private rowToEntry(row: Record<string, unknown>): DbRepoEntry {
    const entry: DbRepoEntry = { name: row.name as string }
    if (row.path) entry.path = row.path as string
    if (row.github_owner) entry.githubOwner = row.github_owner as string
    if (row.github_repo) entry.githubRepo = row.github_repo as string
    if (row.workflow) entry.workflow = row.workflow as RepoWorkflow
    return entry
  }
}
