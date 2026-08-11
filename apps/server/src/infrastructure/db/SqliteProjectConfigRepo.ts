import type { ProjectConfig } from '@ia-flow/shared'
import type { IAgentRepository } from '../../domain/ports/IAgentRepository.js'
import type { IGlobalSettingsRepository } from '../../domain/ports/IGlobalSettingsRepository.js'
import type { IProjectConfigRepository } from '../../domain/ports/IProjectConfigRepository.js'
import type { IProjectRepository } from '../../domain/ports/IProjectRepository.js'
import type { IStatusRepository } from '../../domain/ports/IStatusRepository.js'
import type { ISystemPromptRepository } from '../../domain/ports/ISystemPromptRepository.js'

// Read-only aggregate over per-domain repos. Writes go through the granular
// per-domain endpoints (agents-crud, system-prompts, statuses, projects PATCH).
//
// scope semantics:
//   undefined → default project
//   string    → that specific project — reads use overlay (project + globals)
//   null      → global rows only (project_id IS NULL); statuses are empty
//               since they always belong to a project
export class SqliteProjectConfigRepo implements IProjectConfigRepository {
  constructor(
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
}
