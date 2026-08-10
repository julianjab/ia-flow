import type { Database } from 'bun:sqlite'
import type { ProjectConfig } from '@ia-flow/shared'
import {
  getDefaultProjectId,
  listAgentsForRuntime,
  listDbStatuses,
  saveProjectConfigToDb,
} from '../../db.js'
import type { IProjectConfigRepository } from '../../domain/ports/IProjectConfigRepository.js'
import type { ISystemPromptRepository } from '../../domain/ports/ISystemPromptRepository.js'

// Thin adapter over the plain SQL helpers in db.ts. The db module owns the
// overlay semantics for agents/statuses; system prompts are delegated to
// ISystemPromptRepository so both routes and the daemon share the same code
// path.
export class SqliteProjectConfigRepo implements IProjectConfigRepository {
  constructor(
    private db: Database,
    private systemPromptRepo: ISystemPromptRepository,
  ) {}

  async getConfig(projectId?: string): Promise<ProjectConfig> {
    const pid = projectId ?? getDefaultProjectId()
    const settings = this.getProjectSettings()
    const systemPrompts = this.systemPromptRepo.listForRuntime(pid)
    const scanRoots = this.getScanRoots()
    return {
      project: {
        name: settings['project.name'],
        language: settings['project.language'],
      },
      systemPrompts: systemPrompts.length ? systemPrompts : undefined,
      agents: listAgentsForRuntime(pid),
      statuses: listDbStatuses(pid),
      scanRoots: scanRoots.length ? scanRoots : undefined,
    }
  }

  async saveConfig(config: ProjectConfig, projectId?: string): Promise<void> {
    saveProjectConfigToDb(config, projectId)
  }

  private getProjectSettings(): Record<string, string> {
    const rows = this.db.query('SELECT key, value FROM project_settings').all() as {
      key: string
      value: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
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
}
