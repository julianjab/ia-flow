import type { Database } from 'bun:sqlite'
import type { ISeenItemRepository } from '../../../domain/ports/ISeenItemRepository.js'

export class SqliteSeenItemRepository implements ISeenItemRepository {
  constructor(private readonly db: Database) {}

  get(projectId: string, itemId: string): string | undefined {
    const row = this.db
      .query('SELECT status FROM seen_items WHERE project_id = ? AND item_id = ?')
      .get(projectId, itemId) as { status: string } | undefined
    return row?.status
  }

  set(projectId: string, itemId: string, status: string): void {
    this.db.run(
      `INSERT INTO seen_items (project_id, item_id, status, seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, item_id) DO UPDATE SET status = excluded.status, seen_at = excluded.seen_at`,
      [projectId, itemId, status, new Date().toISOString()],
    )
  }

  hasSeen(projectId: string): boolean {
    const row = this.db
      .query('SELECT 1 AS present FROM seen_items WHERE project_id = ? LIMIT 1')
      .get(projectId) as { present: number } | undefined
    return row != null
  }
}
