import type { Database } from 'bun:sqlite'
import type { AgentRow, PipelineRow, ProjectRow, RepoRow } from '@ia-flow/engine-v2'

/**
 * Un store por entidad — `list/get/upsert/delete`, cada fila un JSON blob
 * bajo `data`. Nunca traduce forma (eso es `fromRow`/`toRow`, en
 * `packages/engine-v2`); esto sólo sabe leer y escribir bytes.
 */
export class ProjectStore {
  constructor(private readonly db: Database) {}

  list(): ProjectRow[] {
    return this.db
      .query('SELECT data FROM projects ORDER BY id')
      .all()
      .map((row) => JSON.parse((row as { data: string }).data) as ProjectRow)
  }

  get(id: string): ProjectRow | null {
    const row = this.db.query('SELECT data FROM projects WHERE id = ?').get(id) as
      | { data: string }
      | null
    return row == null ? null : (JSON.parse(row.data) as ProjectRow)
  }

  upsert(row: ProjectRow): void {
    this.db
      .query(
        'INSERT INTO projects (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      .run(row.id, JSON.stringify(row))
  }

  delete(id: string): void {
    this.db.query('DELETE FROM projects WHERE id = ?').run(id)
  }
}

/** Clave compuesta `(project_id, name)` — mismo motivo que el índice
 *  estático de `Repo`: `name` sólo es único DENTRO de un proyecto. */
export class RepoStore {
  constructor(private readonly db: Database) {}

  list(): RepoRow[] {
    return this.db
      .query('SELECT data FROM repos ORDER BY project_id, name')
      .all()
      .map((row) => JSON.parse((row as { data: string }).data) as RepoRow)
  }

  listByProject(projectId: string): RepoRow[] {
    return this.db
      .query('SELECT data FROM repos WHERE project_id = ? ORDER BY name')
      .all(projectId)
      .map((row) => JSON.parse((row as { data: string }).data) as RepoRow)
  }

  get(projectId: string, name: string): RepoRow | null {
    const row = this.db
      .query('SELECT data FROM repos WHERE project_id = ? AND name = ?')
      .get(projectId, name) as { data: string } | null
    return row == null ? null : (JSON.parse(row.data) as RepoRow)
  }

  upsert(row: RepoRow): void {
    this.db
      .query(
        'INSERT INTO repos (project_id, name, data) VALUES (?, ?, ?) ' +
          'ON CONFLICT(project_id, name) DO UPDATE SET data = excluded.data',
      )
      .run(row.projectId, row.name, JSON.stringify(row))
  }

  delete(projectId: string, name: string): void {
    this.db.query('DELETE FROM repos WHERE project_id = ? AND name = ?').run(projectId, name)
  }
}

export class AgentStore {
  constructor(private readonly db: Database) {}

  list(): AgentRow[] {
    return this.db
      .query('SELECT data FROM agents ORDER BY id')
      .all()
      .map((row) => JSON.parse((row as { data: string }).data) as AgentRow)
  }

  get(id: string): AgentRow | null {
    const row = this.db.query('SELECT data FROM agents WHERE id = ?').get(id) as
      | { data: string }
      | null
    return row == null ? null : (JSON.parse(row.data) as AgentRow)
  }

  upsert(row: AgentRow): void {
    this.db
      .query(
        'INSERT INTO agents (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      .run(row.id, JSON.stringify(row))
  }

  delete(id: string): void {
    this.db.query('DELETE FROM agents WHERE id = ?').run(id)
  }
}

export class PipelineStore {
  constructor(private readonly db: Database) {}

  list(): PipelineRow[] {
    return this.db
      .query('SELECT data FROM pipelines ORDER BY id')
      .all()
      .map((row) => JSON.parse((row as { data: string }).data) as PipelineRow)
  }

  get(id: string): PipelineRow | null {
    const row = this.db.query('SELECT data FROM pipelines WHERE id = ?').get(id) as
      | { data: string }
      | null
    return row == null ? null : (JSON.parse(row.data) as PipelineRow)
  }

  upsert(row: PipelineRow): void {
    this.db
      .query(
        'INSERT INTO pipelines (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      .run(row.id, JSON.stringify(row))
  }

  delete(id: string): void {
    this.db.query('DELETE FROM pipelines WHERE id = ?').run(id)
  }
}
