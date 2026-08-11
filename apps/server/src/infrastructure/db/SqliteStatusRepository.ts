import type { Database } from 'bun:sqlite'
import type { StatusConfig } from '@ia-flow/shared'
import type { IStatusRepository } from '../../domain/ports/IStatusRepository.js'

// The `context_repos` column is a leftover from the deprecated
// StatusConfig.context.repos filter. We stopped reading/writing it; the
// column stays on disk until a follow-up migration drops it.
export class SqliteStatusRepository implements IStatusRepository {
  constructor(private db: Database) {}

  list(projectId?: string): StatusConfig[] {
    const sql =
      projectId === undefined
        ? 'SELECT name, project_id, agents FROM statuses ORDER BY project_id, position'
        : 'SELECT name, project_id, agents FROM statuses WHERE project_id = ? ORDER BY position'
    const params = projectId === undefined ? [] : [projectId]
    const rows = this.db.query(sql).all(...params) as Record<string, unknown>[]
    return rows.map((r) => ({
      name: r.name as string,
      projectId: r.project_id as string,
      agents: JSON.parse(r.agents as string),
    }))
  }

  upsert(status: StatusConfig, position: number, projectId: string): void {
    this.db.run(
      `INSERT INTO statuses (project_id, name, position, agents)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, name) DO UPDATE SET
         position = excluded.position,
         agents   = excluded.agents`,
      [projectId, status.name, position, JSON.stringify(status.agents)],
    )
  }

  clearScope(projectId: string): void {
    this.db.run('DELETE FROM statuses WHERE project_id = ?', [projectId])
  }
}
