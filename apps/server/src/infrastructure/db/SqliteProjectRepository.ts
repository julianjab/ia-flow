import type { Database } from 'bun:sqlite'
import type { Project } from '@ia-flow/shared'
import type { IProjectRepository, ProjectInput } from '../../domain/ports/IProjectRepository.js'

function rowToProject(row: Record<string, unknown>): Project {
  const kind = (row.source_kind as string | null) ?? null
  const rawConfig = (row.source_config as string | null) ?? null
  const source = kind
    ? {
        kind,
        config: rawConfig ? (JSON.parse(rawConfig) as Record<string, unknown>) : {},
      }
    : undefined
  const language = (row.language as string | null) ?? undefined
  return {
    id: row.id as string,
    name: row.name as string,
    ...(language !== undefined && language !== null ? { language } : {}),
    source,
    settings: row.settings ? (JSON.parse(row.settings as string) as Record<string, unknown>) : {},
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: (row.archived_at as string | null) ?? null,
  }
}

export class SqliteProjectRepository implements IProjectRepository {
  constructor(private db: Database) {}

  getDefaultId(): string {
    const row = this.db
      .query('SELECT id FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC LIMIT 1')
      .get() as { id: string } | null
    if (!row) throw new Error('No project exists — migration 005 must run before DB access')
    return row.id
  }

  list(includeArchived = false): Project[] {
    const sql = includeArchived
      ? 'SELECT * FROM projects ORDER BY created_at ASC'
      : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC'
    const rows = this.db.query(sql).all() as Record<string, unknown>[]
    return rows.map(rowToProject)
  }

  get(id: string): Project | null {
    const row = this.db.query('SELECT * FROM projects WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | null
    return row ? rowToProject(row) : null
  }

  upsert(input: ProjectInput): Project {
    const now = new Date().toISOString()
    const settings = input.settings ?? {}
    const sourceKind = input.source?.kind ?? null
    const sourceConfig = input.source ? JSON.stringify(input.source.config ?? {}) : null
    const language = input.language ?? null
    this.db.run(
      `INSERT INTO projects (id, name, language, source_kind, source_config, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name          = excluded.name,
         language      = excluded.language,
         source_kind   = excluded.source_kind,
         source_config = excluded.source_config,
         settings      = excluded.settings,
         updated_at    = excluded.updated_at`,
      [
        input.id,
        input.name,
        language,
        sourceKind,
        sourceConfig,
        JSON.stringify(settings),
        now,
        now,
      ],
    )
    const created = this.get(input.id)
    if (!created) throw new Error(`Project ${input.id} not found after upsert`)
    return created
  }

  archive(id: string): void {
    const now = new Date().toISOString()
    this.db.run('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?', [now, now, id])
  }

  deleteCascade(id: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM statuses WHERE project_id = ?', [id])
      this.db.run('DELETE FROM agents WHERE project_id = ?', [id])
      this.db.run('DELETE FROM system_prompts WHERE project_id = ?', [id])
      // repos.project_id has ON DELETE CASCADE (migration 011), but we drop
      // explicitly here for symmetry with the other tables.
      this.db.run('DELETE FROM repos WHERE project_id = ?', [id])
      this.db.run('DELETE FROM projects WHERE id = ?', [id])
    })()
  }
}
