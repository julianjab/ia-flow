import type { Database } from 'bun:sqlite'
import type { AgentDefinition, ProjectConfig, StatusConfig, SystemPromptDef } from '@ia-flow/shared'
import type { IProjectConfigRepository } from '../../domain/ports/IProjectConfigRepository.js'

export class SqliteProjectConfigRepo implements IProjectConfigRepository {
  constructor(private db: Database) {}

  async getConfig(): Promise<ProjectConfig> {
    const settings = this.getProjectSettings()
    const systemPrompts = this.listSystemPrompts()
    const scanRoots = this.getScanRoots()
    return {
      project: {
        name: settings['project.name'],
        language: settings['project.language'],
      },
      systemPrompts: systemPrompts.length ? systemPrompts : undefined,
      agents: this.listAgents(),
      statuses: this.listStatuses(),
      scanRoots: scanRoots.length ? scanRoots : undefined,
    }
  }

  async saveConfig(config: ProjectConfig): Promise<void> {
    this.db.transaction(() => {
      const s: Record<string, string> = {}
      if (config.project?.name !== undefined) s['project.name'] = config.project.name
      if (config.project?.language !== undefined) s['project.language'] = config.project.language
      if (Object.keys(s).length) this.setProjectSettings(s)

      if (config.systemPrompts !== undefined) {
        this.db.run('DELETE FROM system_prompts')
        config.systemPrompts.forEach((sp, i) => this.upsertSystemPrompt(sp, i))
      }

      if (config.agents !== undefined) {
        this.db.run('DELETE FROM agents')
        config.agents.forEach((a, i) => this.upsertAgent(a, i))
      }

      if (config.statuses !== undefined) {
        this.db.run('DELETE FROM statuses')
        config.statuses.forEach((s, i) => this.upsertStatus(s, i))
      }
    })()
  }

  private getProjectSettings(): Record<string, string> {
    const rows = this.db.query('SELECT key, value FROM project_settings').all() as {
      key: string
      value: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }

  private setProjectSettings(settings: Record<string, string>): void {
    for (const [key, value] of Object.entries(settings)) {
      this.db.run(
        `INSERT INTO project_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
      )
    }
  }

  private getScanRoots(): string[] {
    const row = this.db
      .query('SELECT value FROM project_settings WHERE key = ?')
      .get('scan_roots') as { value: string } | null
    if (!row) return []
    try {
      return JSON.parse(row.value) as string[]
    } catch {
      return []
    }
  }

  private listSystemPrompts(): SystemPromptDef[] {
    const rows = this.db.query('SELECT * FROM system_prompts ORDER BY position').all() as Record<
      string,
      unknown
    >[]
    return rows.map((r) => ({ id: r.id as string, name: r.name as string, text: r.text as string }))
  }

  private upsertSystemPrompt(sp: SystemPromptDef, position: number): void {
    this.db.run(
      `INSERT INTO system_prompts (id, name, text, position)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name     = excluded.name,
         text     = excluded.text,
         position = excluded.position`,
      [sp.id, sp.name, sp.text, position],
    )
  }

  private listAgents(): AgentDefinition[] {
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

  private upsertAgent(agent: AgentDefinition, position: number): void {
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

  private listStatuses(): StatusConfig[] {
    const rows = this.db.query('SELECT * FROM statuses ORDER BY position').all() as Record<
      string,
      unknown
    >[]
    return rows.map((r) => ({
      name: r.name as string,
      context: this.deserializeContextRepos(r.context_repos as string | null),
      agents: JSON.parse(r.agents as string),
    }))
  }

  private upsertStatus(status: StatusConfig, position: number): void {
    this.db.run(
      `INSERT INTO statuses (name, position, context_repos, agents)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         position      = excluded.position,
         context_repos = excluded.context_repos,
         agents        = excluded.agents`,
      [
        status.name,
        position,
        this.serializeContextRepos(status.context),
        JSON.stringify(status.agents),
      ],
    )
  }

  private serializeContextRepos(context: StatusConfig['context']): string | null {
    const r = context?.repos
    if (r === undefined) return null
    if (r === 'task' || r === 'all') return r
    return JSON.stringify(r)
  }

  private deserializeContextRepos(raw: string | null): StatusConfig['context'] {
    if (raw === null) return undefined
    if (raw === 'task' || raw === 'all') return { repos: raw }
    try {
      return { repos: JSON.parse(raw) }
    } catch {
      return undefined
    }
  }
}
