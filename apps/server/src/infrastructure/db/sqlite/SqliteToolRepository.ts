import type { Database } from 'bun:sqlite'
import type { EditableTool } from '@ia-flow/shared'
import type { IToolRepository } from '../../../domain/ports/IToolRepository.js'

function rowToTool(r: Record<string, unknown>): EditableTool {
  const base = {
    name: r.name as string,
    description: r.description as string,
    createdAt: (r.created_at as string | null) ?? undefined,
    updatedAt: (r.updated_at as string | null) ?? undefined,
  }
  if (r.kind === 'override') return { ...base, kind: 'override' }
  return {
    ...base,
    kind: 'defined',
    actionId: r.action_id as string,
    projectId: (r.project_id as string | null) ?? null,
    inputSchema: r.input_schema
      ? (JSON.parse(r.input_schema as string) as Record<string, unknown>)
      : undefined,
  }
}

export class SqliteToolRepository implements IToolRepository {
  constructor(private readonly db: Database) {}

  isReadOnly(): boolean {
    return false
  }

  /** Las del proyecto MÁS las globales. Sin proyecto, sólo las globales — el
   *  ámbito General, que es donde viven las que todos heredan. */
  async visibleTo(projectId?: string): Promise<EditableTool[]> {
    const rows = projectId
      ? (this.db
          .query('SELECT * FROM tools WHERE project_id IS NULL OR project_id = ? ORDER BY name')
          .all(projectId) as Record<string, unknown>[])
      : (this.db
          .query('SELECT * FROM tools WHERE project_id IS NULL ORDER BY name')
          .all() as Record<string, unknown>[])
    return rows.map(rowToTool)
  }

  async list(scope?: { projectId?: string | null; global?: boolean }): Promise<EditableTool[]> {
    if (scope?.global) {
      return (
        this.db.query('SELECT * FROM tools WHERE project_id IS NULL ORDER BY name').all() as Record<
          string,
          unknown
        >[]
      ).map(rowToTool)
    }
    if (scope?.projectId) {
      return (
        this.db
          .query('SELECT * FROM tools WHERE project_id = ? ORDER BY name')
          .all(scope.projectId) as Record<string, unknown>[]
      ).map(rowToTool)
    }
    // Sin scope, TODAS: es lo que registra `applyEditableTools` sobre el
    // registry del proceso, que es uno solo para todos los proyectos.
    return (
      this.db.query('SELECT * FROM tools ORDER BY name').all() as Record<string, unknown>[]
    ).map(rowToTool)
  }

  async getByName(name: string): Promise<EditableTool | null> {
    const row = this.db.query('SELECT * FROM tools WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined
    return row ? rowToTool(row) : null
  }

  async upsert(tool: EditableTool): Promise<EditableTool> {
    const now = new Date().toISOString()
    const defined = tool.kind === 'defined' ? tool : null
    this.db.run(
      `INSERT INTO tools (name, kind, description, input_schema, action_id, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         kind         = excluded.kind,
         description  = excluded.description,
         input_schema = excluded.input_schema,
         action_id    = excluded.action_id,
         project_id   = excluded.project_id,
         updated_at   = excluded.updated_at`,
      [
        tool.name,
        tool.kind,
        tool.description,
        defined?.inputSchema ? JSON.stringify(defined.inputSchema) : null,
        defined?.actionId ?? null,
        defined?.projectId ?? null,
        tool.createdAt ?? now,
        now,
      ],
    )
    return { ...tool, createdAt: tool.createdAt ?? now, updatedAt: now }
  }

  async deleteByName(name: string): Promise<boolean> {
    return this.db.run('DELETE FROM tools WHERE name = ?', [name]).changes > 0
  }
}
