import type { Database } from 'bun:sqlite'
import type { AssistCallerConfig } from '@ia-flow/shared'
import type { IAssistCallerConfigRepository } from '../../../domain/ports/IAssistCallerConfigRepository.js'

function rowToConfig(r: Record<string, unknown>): AssistCallerConfig {
  const raw = r.system_prompts as string | null
  return {
    agentId: r.agent_id as string,
    systemPrompts: raw ? JSON.parse(raw) : [],
  }
}

export class SqliteAssistCallerConfigRepository implements IAssistCallerConfigRepository {
  constructor(private db: Database) {}

  list(): AssistCallerConfig[] {
    const rows = this.db
      .query('SELECT * FROM assist_caller_configs ORDER BY agent_id')
      .all() as Record<string, unknown>[]
    return rows.map(rowToConfig)
  }

  getById(agentId: string): AssistCallerConfig | null {
    const row = this.db
      .query('SELECT * FROM assist_caller_configs WHERE agent_id = ? LIMIT 1')
      .get(agentId) as Record<string, unknown> | null
    return row ? rowToConfig(row) : null
  }

  upsert(config: AssistCallerConfig): void {
    this.db.run(
      `INSERT INTO assist_caller_configs (agent_id, system_prompts)
       VALUES (?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET system_prompts = excluded.system_prompts`,
      [config.agentId, JSON.stringify(config.systemPrompts ?? [])],
    )
  }

  deleteById(agentId: string): void {
    this.db.run('DELETE FROM assist_caller_configs WHERE agent_id = ?', [agentId])
  }
}
