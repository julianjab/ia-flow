import type { Database } from 'bun:sqlite'
import type { NamedAction, NamedActionBody } from '@ia-flow/shared'
import type { IActionRepository } from '../../../domain/ports/IActionRepository.js'

function rowToAction(r: Record<string, unknown>): NamedAction {
  return {
    id: r.id as string,
    name: (r.name as string | null) ?? undefined,
    description: (r.description as string | null) ?? undefined,
    projectId: (r.project_id as string | null) ?? null,
    body: JSON.parse(r.body as string) as NamedActionBody,
    createdAt: (r.created_at as string | null) ?? undefined,
    updatedAt: (r.updated_at as string | null) ?? undefined,
  }
}

export class SqliteActionRepository implements IActionRepository {
  constructor(private readonly db: Database) {}

  isReadOnly(): boolean {
    return false
  }

  async visibleTo(projectId?: string): Promise<NamedAction[]> {
    // Sin projectId, SÓLO las globales — mismo fail-closed que las reglas: un
    // evento sin scope no puede alcanzar la configuración de un proyecto.
    const rows = projectId
      ? (this.db
          .query('SELECT * FROM actions WHERE project_id IS NULL OR project_id = ? ORDER BY id')
          .all(projectId) as Record<string, unknown>[])
      : (this.db
          .query('SELECT * FROM actions WHERE project_id IS NULL ORDER BY id')
          .all() as Record<string, unknown>[])
    return rows.map(rowToAction)
  }

  async list(scope?: { projectId?: string | null; global?: boolean }): Promise<NamedAction[]> {
    if (scope?.global) {
      return (
        this.db.query('SELECT * FROM actions WHERE project_id IS NULL ORDER BY id').all() as Record<
          string,
          unknown
        >[]
      ).map(rowToAction)
    }
    if (scope?.projectId) {
      return (
        this.db
          .query('SELECT * FROM actions WHERE project_id = ? ORDER BY id')
          .all(scope.projectId) as Record<string, unknown>[]
      ).map(rowToAction)
    }
    return (
      this.db.query('SELECT * FROM actions ORDER BY id').all() as Record<string, unknown>[]
    ).map(rowToAction)
  }

  async getById(id: string): Promise<NamedAction | null> {
    const row = this.db.query('SELECT * FROM actions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToAction(row) : null
  }

  async upsert(action: NamedAction): Promise<NamedAction> {
    const now = new Date().toISOString()
    // `created_at` se preserva en el UPDATE: es la fecha de alta, no la de la
    // última escritura, y pisarla borraría la única señal de antigüedad.
    this.db.run(
      `INSERT INTO actions (id, name, description, project_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name        = excluded.name,
         description = excluded.description,
         project_id  = excluded.project_id,
         body        = excluded.body,
         updated_at  = excluded.updated_at`,
      [
        action.id,
        action.name ?? null,
        action.description ?? null,
        action.projectId ?? null,
        JSON.stringify(action.body),
        action.createdAt ?? now,
        now,
      ],
    )
    return { ...action, createdAt: action.createdAt ?? now, updatedAt: now }
  }

  async deleteById(id: string): Promise<boolean> {
    return this.db.run('DELETE FROM actions WHERE id = ?', [id]).changes > 0
  }
}
