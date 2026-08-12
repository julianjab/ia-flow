import type { Database } from 'bun:sqlite'
import type { AgentDefinition } from '@ia-flow/shared'
import type { IAgentRepository } from '../../domain/ports/IAgentRepository.js'

function rowToAgent(r: Record<string, unknown>): AgentDefinition {
  return {
    id: r.id as string,
    provider: r.provider as string,
    prompt: r.prompt as string,
    variables: r.variables
      ? (JSON.parse(r.variables as string) as Record<string, string>)
      : undefined,
    tools: r.tools ? (JSON.parse(r.tools as string) as string[]) : undefined,
    // Per-agent tool opt-out (see AgentDefinitionSchema.disabledTools). Read
    // as a JSON string[] the same way `tools` and `mcp_catalog_ids` are.
    disabledTools: r.disabled_tools
      ? (JSON.parse(r.disabled_tools as string) as string[])
      : undefined,
    systemPrompts: r.system_prompts
      ? (JSON.parse(r.system_prompts as string) as string[])
      : undefined,
    save_output: r.save_output != null ? (r.save_output as number) !== 0 : undefined,
    providerConfig: r.provider_config
      ? (JSON.parse(r.provider_config as string) as Record<string, unknown>)
      : undefined,
    mcpCatalogIds: r.mcp_catalog_ids
      ? (JSON.parse(r.mcp_catalog_ids as string) as string[])
      : undefined,
    projectId: (r.project_id as string | null) ?? null,
  }
}

export class SqliteAgentRepository implements IAgentRepository {
  constructor(private db: Database) {}

  inScope(projectId?: string | null): AgentDefinition[] {
    let sql = 'SELECT * FROM agents'
    const params: (string | null)[] = []
    if (projectId === null) {
      sql += ' WHERE project_id IS NULL'
    } else if (typeof projectId === 'string') {
      sql += ' WHERE project_id = ?'
      params.push(projectId)
    }
    sql += ' ORDER BY position'
    const rows = this.db.query(sql).all(...params) as Record<string, unknown>[]
    return rows.map(rowToAgent)
  }

  visibleTo(projectId: string): AgentDefinition[] {
    const rows = this.db
      .query('SELECT * FROM agents WHERE project_id = ? OR project_id IS NULL ORDER BY position')
      .all(projectId) as Record<string, unknown>[]
    const byId = new Map<string, AgentDefinition>()
    for (const r of rows) {
      const a = rowToAgent(r)
      const existing = byId.get(a.id)
      if (!existing || (existing.projectId == null && a.projectId != null)) byId.set(a.id, a)
    }
    return Array.from(byId.values())
  }

  upsert(agent: AgentDefinition, position: number, projectId?: string | null): void {
    const pid = projectId === undefined ? (agent.projectId ?? null) : projectId
    this.db.run(
      `INSERT INTO agents (id, position, provider, prompt, variables, tools, disabled_tools, system_prompts, save_output, provider_config, mcp_catalog_ids, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         position        = excluded.position,
         provider        = excluded.provider,
         prompt          = excluded.prompt,
         variables       = excluded.variables,
         tools           = excluded.tools,
         disabled_tools  = excluded.disabled_tools,
         system_prompts  = excluded.system_prompts,
         save_output     = excluded.save_output,
         provider_config = excluded.provider_config,
         mcp_catalog_ids = excluded.mcp_catalog_ids,
         project_id      = excluded.project_id`,
      [
        agent.id,
        position,
        agent.provider,
        agent.prompt,
        agent.variables ? JSON.stringify(agent.variables) : null,
        agent.tools?.length ? JSON.stringify(agent.tools) : null,
        agent.disabledTools?.length ? JSON.stringify(agent.disabledTools) : null,
        agent.systemPrompts?.length ? JSON.stringify(agent.systemPrompts) : null,
        agent.save_output === false ? 0 : agent.save_output === true ? 1 : null,
        agent.providerConfig && Object.keys(agent.providerConfig).length > 0
          ? JSON.stringify(agent.providerConfig)
          : null,
        agent.mcpCatalogIds?.length ? JSON.stringify(agent.mcpCatalogIds) : null,
        pid,
      ],
    )
  }

  deleteById(id: string): void {
    this.db.run('DELETE FROM agents WHERE id = ?', [id])
  }

  clearScope(projectId: string | null): void {
    if (projectId === null) {
      this.db.run('DELETE FROM agents WHERE project_id IS NULL')
    } else {
      this.db.run('DELETE FROM agents WHERE project_id = ?', [projectId])
    }
  }
}
