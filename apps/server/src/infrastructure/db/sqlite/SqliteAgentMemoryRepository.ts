import type { Database } from 'bun:sqlite'
import type { AgentMemoryEntry } from '@ia-flow/shared'
import type { IAgentMemoryRepository } from '../../../domain/ports/IAgentMemoryRepository.js'

function rowToEntry(r: Record<string, unknown>): AgentMemoryEntry {
  return {
    agentId: r.agent_id as string,
    projectId: r.project_id as string,
    key: r.key as string,
    value: r.value as string,
    updatedAt: r.updated_at as string,
  }
}

/** Escapa los comodines de LIKE para que un término con `%` o `_` busque esos
 *  caracteres literales en vez de convertirse en "traeme todo". */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export class SqliteAgentMemoryRepository implements IAgentMemoryRepository {
  constructor(private db: Database) {}

  get(agentId: string, projectId: string, key: string): AgentMemoryEntry | null {
    const row = this.db
      .query(
        'SELECT * FROM agent_memories WHERE agent_id = ? AND project_id = ? AND key = ? LIMIT 1',
      )
      .get(agentId, projectId, key) as Record<string, unknown> | null
    return row ? rowToEntry(row) : null
  }

  list(agentId: string, projectId: string): AgentMemoryEntry[] {
    const rows = this.db
      .query('SELECT * FROM agent_memories WHERE agent_id = ? AND project_id = ? ORDER BY key')
      .all(agentId, projectId) as Record<string, unknown>[]
    return rows.map(rowToEntry)
  }

  search(agentId: string, projectId: string, term: string): AgentMemoryEntry[] {
    // LIKE es case-insensitive en SQLite para ASCII sin más configuración; el
    // LOWER() explícito lo extiende a los acentos que un PRD en español sí usa.
    const pattern = `%${escapeLike(term.toLowerCase())}%`
    const rows = this.db
      .query(
        `SELECT * FROM agent_memories
          WHERE agent_id = ? AND project_id = ?
            AND (LOWER(key) LIKE ? ESCAPE '\\' OR LOWER(value) LIKE ? ESCAPE '\\')
          ORDER BY key`,
      )
      .all(agentId, projectId, pattern, pattern) as Record<string, unknown>[]
    return rows.map(rowToEntry)
  }

  upsert(entry: AgentMemoryEntry): void {
    this.db.run(
      `INSERT INTO agent_memories (agent_id, project_id, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, project_id, key) DO UPDATE SET
         value      = excluded.value,
         updated_at = excluded.updated_at`,
      [entry.agentId, entry.projectId, entry.key, entry.value, entry.updatedAt],
    )
  }

  deleteByKey(agentId: string, projectId: string, key: string): boolean {
    // `changes` distingue "borré una" de "no había nada": es lo que deja que
    // `memory_delete` le conteste al agente si la key existía.
    const res = this.db.run(
      'DELETE FROM agent_memories WHERE agent_id = ? AND project_id = ? AND key = ?',
      [agentId, projectId, key],
    )
    return res.changes > 0
  }
}
