import type { Database } from 'bun:sqlite'
import type { StatusConfig } from '@ia-flow/shared'
import type { IStatusRepository } from '../../domain/ports/IStatusRepository.js'

// The `context_repos` column is a leftover from the deprecated
// StatusConfig.context.repos filter. We stopped reading/writing it; the
// column stays on disk until a follow-up migration drops it.
export class SqliteStatusRepository implements IStatusRepository {
  constructor(private db: Database) {}

  private rowToStatus(r: Record<string, unknown>): StatusConfig {
    const status: StatusConfig = {
      name: r.name as string,
      projectId: r.project_id as string,
      agents: JSON.parse(r.agents as string),
    }
    // Only emit the field when truthy so serialized configs stay clean.
    if (r.allow_blocked === 1) status.allowBlocked = true
    return status
  }

  list(projectId?: string): StatusConfig[] {
    const sql =
      projectId === undefined
        ? 'SELECT name, project_id, agents, allow_blocked FROM statuses ORDER BY project_id, position'
        : 'SELECT name, project_id, agents, allow_blocked FROM statuses WHERE project_id = ? ORDER BY position'
    const params = projectId === undefined ? [] : [projectId]
    const rows = this.db.query(sql).all(...params) as Record<string, unknown>[]
    return rows.map((r) => this.rowToStatus(r))
  }

  getByName(projectId: string, name: string): StatusConfig | null {
    const row = this.db
      .query(
        'SELECT name, project_id, agents, allow_blocked FROM statuses WHERE project_id = ? AND name = ?',
      )
      .get(projectId, name) as Record<string, unknown> | null
    if (!row) return null
    return this.rowToStatus(row)
  }

  deleteByName(projectId: string, name: string): void {
    this.db.run('DELETE FROM statuses WHERE project_id = ? AND name = ?', [projectId, name])
  }

  upsert(status: StatusConfig, position: number, projectId: string): void {
    this.db.run(
      `INSERT INTO statuses (project_id, name, position, agents, allow_blocked)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, name) DO UPDATE SET
         position      = excluded.position,
         agents        = excluded.agents,
         allow_blocked = excluded.allow_blocked`,
      [
        projectId,
        status.name,
        position,
        JSON.stringify(status.agents),
        status.allowBlocked ? 1 : 0,
      ],
    )
  }

  clearScope(projectId: string): void {
    this.db.run('DELETE FROM statuses WHERE project_id = ?', [projectId])
  }
}
