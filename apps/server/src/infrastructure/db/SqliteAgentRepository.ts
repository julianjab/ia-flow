import type { Database } from 'bun:sqlite'
import type { AgentDefinition } from '@ia-flow/shared'
import type { IAgentRepository } from '../../domain/ports/IAgentRepository.js'

export class SqliteAgentRepository implements IAgentRepository {
  constructor(private db: Database) {}

  listAgents(): AgentDefinition[] {
    const rows = this.db.query('SELECT * FROM agents ORDER BY position').all() as Record<
      string,
      unknown
    >[]
    return rows.map((r) => ({
      id: r.id as string,
      provider: r.provider as string,
      prompt: r.prompt as string,
      variables: r.variables
        ? (JSON.parse(r.variables as string) as Record<string, string>)
        : undefined,
      tools: r.tools ? (JSON.parse(r.tools as string) as string[]) : undefined,
      systemPrompts: r.system_prompts
        ? (JSON.parse(r.system_prompts as string) as string[])
        : undefined,
      save_output: r.save_output != null ? (r.save_output as number) !== 0 : undefined,
    }))
  }

  upsertAgent(agent: AgentDefinition, position: number): void {
    this.db.run(
      `INSERT INTO agents (id, position, provider, prompt, variables, tools, system_prompts, save_output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         position       = excluded.position,
         provider       = excluded.provider,
         prompt         = excluded.prompt,
         variables      = excluded.variables,
         tools          = excluded.tools,
         system_prompts = excluded.system_prompts,
         save_output    = excluded.save_output`,
      [
        agent.id,
        position,
        agent.provider,
        agent.prompt,
        agent.variables ? JSON.stringify(agent.variables) : null,
        agent.tools?.length ? JSON.stringify(agent.tools) : null,
        agent.systemPrompts?.length ? JSON.stringify(agent.systemPrompts) : null,
        agent.save_output === false ? 0 : agent.save_output === true ? 1 : null,
      ],
    )
  }

  deleteAgent(id: string): void {
    this.db.run('DELETE FROM agents WHERE id = ?', [id])
  }

  replaceAgents(agents: AgentDefinition[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM agents')
      agents.forEach((a, i) => this.upsertAgent(a, i))
    })()
  }
}
