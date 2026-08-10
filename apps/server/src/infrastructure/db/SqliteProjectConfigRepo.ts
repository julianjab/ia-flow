import type { Database } from 'bun:sqlite'
import type { ProjectConfig } from '@ia-flow/shared'
import type { IAgentRepository } from '../../domain/ports/IAgentRepository.js'
import type { IProjectConfigRepository } from '../../domain/ports/IProjectConfigRepository.js'
import type { IProjectRepository } from '../../domain/ports/IProjectRepository.js'
import type { IStatusRepository } from '../../domain/ports/IStatusRepository.js'
import type { ISystemPromptRepository } from '../../domain/ports/ISystemPromptRepository.js'

// Aggregate over per-domain repos. Both read and write live here now — no more
// free helpers in db.ts.
//
// scope semantics:
//   undefined → default project (back-compat single-tenant callers)
//   string    → that specific project — reads use overlay, writes are strict
//   null      → global rows only (project_id IS NULL); statuses are skipped
//               since they always belong to a project
export class SqliteProjectConfigRepo implements IProjectConfigRepository {
  constructor(
    private db: Database,
    private systemPromptRepo: ISystemPromptRepository,
    private projectRepo: IProjectRepository,
    private statusRepo: IStatusRepository,
    private settingsRepo: IGlobalSettingsRepository,
    private agentRepo: IAgentRepository,
  ) {}

  async getConfig(scope?: string | null): Promise<ProjectConfig> {
    const resolved = scope === undefined ? this.projectRepo.getDefaultId() : scope
    const project = resolved === null ? null : this.projectRepo.get(resolved)
    const systemPrompts =
      resolved === null
        ? this.systemPromptRepo.inScope(null)
        : this.systemPromptRepo.visibleTo(resolved)
    const agents =
      resolved === null ? this.agentRepo.inScope(null) : this.agentRepo.visibleTo(resolved)
    const scanRoots = this.settingsRepo.getScanRoots()
    return {
      project: {
        name: project?.name,
        language: project?.language,
      },
      systemPrompts: systemPrompts.length ? systemPrompts : undefined,
      agents,
      statuses: resolved === null ? [] : this.statusRepo.list(resolved),
      scanRoots: scanRoots.length ? scanRoots : undefined,
    }
  }

  async saveConfig(config: ProjectConfig, scope?: string | null): Promise<void> {
    const target = scope === undefined ? this.projectRepo.getDefaultId() : scope
    this.db.transaction(() => {
      // Per-project fields on the projects row. Only when a real project is targeted.
      if (
        target !== null &&
        (config.project?.name !== undefined || config.project?.language !== undefined)
      ) {
        const existing = this.projectRepo.get(target)
        if (existing) {
          this.projectRepo.upsert({
            id: existing.id,
            name: config.project?.name ?? existing.name,
            language: config.project?.language ?? existing.language,
            source: existing.source,
            settings: existing.settings,
          })
        }
      }

      if (config.systemPrompts !== undefined) {
        this.systemPromptRepo.clearScope(target)
        config.systemPrompts.forEach((sp, i) => this.systemPromptRepo.upsert(sp, i, target))
      }

      if (config.agents !== undefined) {
        this.agentRepo.clearScope(target)
        config.agents.forEach((a, i) => this.agentRepo.upsert(a, i, target))
      }

      // Statuses always belong to a project — skip for global scope.
      if (config.statuses !== undefined && target !== null) {
        this.statusRepo.clearScope(target)
        config.statuses.forEach((st, i) => this.statusRepo.upsert(st, i, target))
      }
    })()
  }
}
