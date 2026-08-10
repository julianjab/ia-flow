import type { Database } from 'bun:sqlite'
import type { StatusConfig } from '@ia-flow/shared'
import type { IStatusRepository } from '../../domain/ports/IStatusRepository.js'

function serializeContextRepos(repos: StatusConfig['context']): string | null {
  const r = repos?.repos
  if (r === undefined) return null
  if (r === 'task' || r === 'all') return r
  return JSON.stringify(r)
}

function deserializeContextRepos(raw: string | null): StatusConfig['context'] {
  if (raw === null) return undefined
  if (raw === 'task' || raw === 'all') return { repos: raw }
  try {
    return { repos: JSON.parse(raw) }
  } catch {
    return undefined
  }
}

export class SqliteStatusRepository implements IStatusRepository {
  constructor(private db: Database) {}

  list(projectId?: string): StatusConfig[] {
    const sql =
      projectId === undefined
        ? 'SELECT * FROM statuses ORDER BY project_id, position'
        : 'SELECT * FROM statuses WHERE project_id = ? ORDER BY position'
    const params = projectId === undefined ? [] : [projectId]
    const rows = this.db.query(sql).all(...params) as Record<string, unknown>[]
    return rows.map((r) => ({
      name: r.name as string,
      projectId: r.project_id as string,
      context: deserializeContextRepos(r.context_repos as string | null),
      agents: JSON.parse(r.agents as string),
    }))
  }

  upsert(status: StatusConfig, position: number, projectId: string): void {
    this.db.run(
      `INSERT INTO statuses (project_id, name, position, context_repos, agents)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, name) DO UPDATE SET
         position      = excluded.position,
         context_repos = excluded.context_repos,
         agents        = excluded.agents`,
      [
        projectId,
        status.name,
        position,
        serializeContextRepos(status.context),
        JSON.stringify(status.agents),
      ],
    )
  }

  deleteByProject(projectId: string): void {
    this.db.run('DELETE FROM statuses WHERE project_id = ?', [projectId])
  }
}
