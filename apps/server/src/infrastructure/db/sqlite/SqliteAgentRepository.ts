import type { Database } from 'bun:sqlite'
import type { AgentDefinition, AgentToolEntry, WhenCondition } from '@ia-flow/shared'
import type { IAgentRepository } from '../../../domain/ports/IAgentRepository.js'

function rowToAgent(r: Record<string, unknown>): AgentDefinition {
  return {
    id: r.id as string,
    provider: r.provider as string,
    prompt: r.prompt as string,
    variables: r.variables
      ? (JSON.parse(r.variables as string) as Record<string, string>)
      : undefined,
    tools: r.tools ? (JSON.parse(r.tools as string) as AgentToolEntry[]) : undefined,
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
    // Tri-state: NULL en DB → undefined (engine deriva del set de tools).
    requiresBranch: r.requires_branch != null ? (r.requires_branch as number) !== 0 : undefined,
    // ─── Activation criteria (AgentActivationSchema) ─────────────────────
    repoName: (r.repo_name as string | null) ?? undefined,
    statusName: (r.status_name as string | null) ?? undefined,
    when: r.when_conditions
      ? (JSON.parse(r.when_conditions as string) as WhenCondition[] | Record<string, string>)
      : undefined,
    enabled: (r.enabled as number) !== 0,
    position: r.position != null ? (r.position as number) : undefined,
    // ─── Outcomes (AgentOutcomesSchema) ──────────────────────────────────
    onProcess: (r.on_process as string | null) ?? undefined,
    onFinish: (r.on_finish as string | null) ?? undefined,
    onError: (r.on_error as string | null) ?? undefined,
    onProcessLabels: (r.on_process_labels as string | null) ?? undefined,
    onFinishLabels: (r.on_finish_labels as string | null) ?? undefined,
    onErrorLabels: (r.on_error_labels as string | null) ?? undefined,
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

  // `position` param wins over `agent.position`: callers (routes/agents-crud.ts)
  // compute it as the array index within scope (findIndex/length), which is
  // the source of truth for "where does this agent sit among its siblings".
  // `agent.position` on the body is just an echo of what a previous read
  // returned — trusting it here would let a stale client payload silently
  // reorder agents out from under a concurrent `PUT /reorder`. The reorder
  // endpoint itself calls `setPositions`, not `upsert`, to change ordering.
  upsert(agent: AgentDefinition, position: number, projectId?: string | null): void {
    const pid = projectId === undefined ? (agent.projectId ?? null) : projectId
    this.db.run(
      `INSERT INTO agents (
         id, position, provider, prompt, variables, tools,
         system_prompts, save_output, provider_config, mcp_catalog_ids, project_id,
         requires_branch, repo_name, status_name, when_conditions, on_process, on_finish,
         on_error, on_process_labels, on_finish_labels, on_error_labels, enabled
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         position           = excluded.position,
         provider           = excluded.provider,
         prompt              = excluded.prompt,
         variables           = excluded.variables,
         tools               = excluded.tools,
         system_prompts      = excluded.system_prompts,
         save_output         = excluded.save_output,
         provider_config     = excluded.provider_config,
         mcp_catalog_ids     = excluded.mcp_catalog_ids,
         project_id          = excluded.project_id,
         requires_branch     = excluded.requires_branch,
         repo_name           = excluded.repo_name,
         status_name         = excluded.status_name,
         when_conditions     = excluded.when_conditions,
         on_process          = excluded.on_process,
         on_finish           = excluded.on_finish,
         on_error            = excluded.on_error,
         on_process_labels   = excluded.on_process_labels,
         on_finish_labels    = excluded.on_finish_labels,
         on_error_labels     = excluded.on_error_labels,
         enabled             = excluded.enabled`,
      [
        agent.id,
        position,
        agent.provider,
        agent.prompt,
        agent.variables ? JSON.stringify(agent.variables) : null,
        agent.tools?.length ? JSON.stringify(agent.tools) : null,
        agent.systemPrompts?.length ? JSON.stringify(agent.systemPrompts) : null,
        agent.save_output === false ? 0 : agent.save_output === true ? 1 : null,
        agent.providerConfig && Object.keys(agent.providerConfig).length > 0
          ? JSON.stringify(agent.providerConfig)
          : null,
        agent.mcpCatalogIds?.length ? JSON.stringify(agent.mcpCatalogIds) : null,
        pid,
        agent.requiresBranch === false ? 0 : agent.requiresBranch === true ? 1 : null,
        agent.repoName ?? null,
        agent.statusName ?? null,
        agent.when && Object.keys(agent.when).length ? JSON.stringify(agent.when) : null,
        agent.onProcess ?? null,
        agent.onFinish ?? null,
        agent.onError ?? null,
        agent.onProcessLabels ?? null,
        agent.onFinishLabels ?? null,
        agent.onErrorLabels ?? null,
        agent.enabled === false ? 0 : 1,
      ],
    )
  }

  deleteById(id: string): void {
    this.db.run('DELETE FROM agents WHERE id = ?', [id])
  }

  // Transaccional a propósito: el orden es lo que decide qué agente corre, y
  // una aplicación parcial (fallo a mitad del loop) dejaría el pipeline con una
  // prioridad que el usuario nunca eligió. O se reordena entero, o nada.
  setPositions(ids: string[], projectId: string | null): void {
    const scopeSql = projectId === null ? 'project_id IS NULL' : 'project_id = ?'
    const stmt = this.db.query(`UPDATE agents SET position = ? WHERE id = ? AND ${scopeSql}`)
    this.db.transaction(() => {
      ids.forEach((id, index) => {
        if (projectId === null) stmt.run(index, id)
        else stmt.run(index, id, projectId)
      })
    })()
  }

  clearScope(projectId: string | null): void {
    if (projectId === null) {
      this.db.run('DELETE FROM agents WHERE project_id IS NULL')
    } else {
      this.db.run('DELETE FROM agents WHERE project_id = ?', [projectId])
    }
  }
}
