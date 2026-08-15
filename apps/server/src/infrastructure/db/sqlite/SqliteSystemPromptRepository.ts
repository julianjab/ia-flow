import type { Database } from 'bun:sqlite'
import type { SystemPromptDef } from '@ia-flow/shared'
import type { ISystemPromptRepository } from '../../../domain/ports/ISystemPromptRepository.js'

function rowToSystemPrompt(r: Record<string, unknown>): SystemPromptDef {
  return {
    id: r.id as string,
    name: r.name as string,
    text: r.text as string,
    projectId: (r.project_id as string | null) ?? null,
  }
}

export class SqliteSystemPromptRepository implements ISystemPromptRepository {
  constructor(private db: Database) {}

  getById(id: string): SystemPromptDef | null {
    const row = this.db
      .query('SELECT * FROM system_prompts WHERE id = ? LIMIT 1')
      .get(id) as Record<string, unknown> | null
    return row ? rowToSystemPrompt(row) : null
  }

  inScope(projectId?: string | null): SystemPromptDef[] {
    let sql = 'SELECT * FROM system_prompts'
    const params: (string | null)[] = []
    if (projectId === null) {
      sql += ' WHERE project_id IS NULL'
    } else if (typeof projectId === 'string') {
      sql += ' WHERE project_id = ?'
      params.push(projectId)
    }
    sql += ' ORDER BY position'
    const rows = this.db.query(sql).all(...params) as Record<string, unknown>[]
    return rows.map(rowToSystemPrompt)
  }

  visibleTo(projectId: string): SystemPromptDef[] {
    const rows = this.db
      .query(
        'SELECT * FROM system_prompts WHERE project_id = ? OR project_id IS NULL ORDER BY position',
      )
      .all(projectId) as Record<string, unknown>[]
    const byId = new Map<string, SystemPromptDef>()
    for (const r of rows) {
      const sp = rowToSystemPrompt(r)
      const existing = byId.get(sp.id)
      if (!existing || (existing.projectId == null && sp.projectId != null)) byId.set(sp.id, sp)
    }
    return Array.from(byId.values())
  }

  upsert(sp: SystemPromptDef, position: number, projectId?: string | null): void {
    const pid = projectId === undefined ? (sp.projectId ?? null) : projectId
    this.db.run(
      `INSERT INTO system_prompts (id, name, text, position, project_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name       = excluded.name,
         text       = excluded.text,
         position   = excluded.position,
         project_id = excluded.project_id`,
      [sp.id, sp.name, sp.text, position, pid],
    )
  }

  deleteById(id: string): void {
    this.db.run('DELETE FROM system_prompts WHERE id = ?', [id])
  }

  clearScope(projectId: string | null): void {
    if (projectId === null) {
      this.db.run('DELETE FROM system_prompts WHERE project_id IS NULL')
    } else {
      this.db.run('DELETE FROM system_prompts WHERE project_id = ?', [projectId])
    }
  }
}
