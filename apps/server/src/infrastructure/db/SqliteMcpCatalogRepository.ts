import type { Database } from 'bun:sqlite'
import type { McpCatalogEntry, McpServerConfig } from '@ia-flow/shared'
import type { IMcpCatalogRepository } from '../../domain/ports/IMcpCatalogRepository.js'

function rowToEntry(r: Record<string, unknown>): McpCatalogEntry {
  return {
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? undefined,
    config: JSON.parse(r.config as string) as McpServerConfig,
  }
}

export class SqliteMcpCatalogRepository implements IMcpCatalogRepository {
  constructor(private db: Database) {}

  list(): McpCatalogEntry[] {
    const rows = this.db.query('SELECT * FROM mcp_catalog ORDER BY position').all() as Record<
      string,
      unknown
    >[]
    return rows.map(rowToEntry)
  }

  get(id: string): McpCatalogEntry | null {
    const row = this.db.query('SELECT * FROM mcp_catalog WHERE id = ? LIMIT 1').get(id) as Record<
      string,
      unknown
    > | null
    return row ? rowToEntry(row) : null
  }

  upsert(entry: McpCatalogEntry, position: number): void {
    this.db.run(
      `INSERT INTO mcp_catalog (id, name, description, config, position)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name        = excluded.name,
         description = excluded.description,
         config      = excluded.config,
         position    = excluded.position`,
      [entry.id, entry.name, entry.description ?? null, JSON.stringify(entry.config), position],
    )
  }

  deleteById(id: string): void {
    this.db.run('DELETE FROM mcp_catalog WHERE id = ?', [id])
  }
}
