import type { Database } from 'bun:sqlite'
import type { ProjectConfig } from '@ia-flow/shared'
import { saveProjectConfigToDb } from '../../db.js'
import type { IAgentRepository } from '../../domain/ports/IAgentRepository.js'
import type { IProjectConfigRepository } from '../../domain/ports/IProjectConfigRepository.js'
import type { IProjectRepository } from '../../domain/ports/IProjectRepository.js'
import type { IProjectSettingsRepository } from '../../domain/ports/IProjectSettingsRepository.js'
import type { IStatusRepository } from '../../domain/ports/IStatusRepository.js'
import type { ISystemPromptRepository } from '../../domain/ports/ISystemPromptRepository.js'

// Aggregate that composes the per-domain repos to expose the same
// ProjectConfig view the daemon and routes need. Save still delegates to
// the plain SQL helper in db.ts — folded away in step 8.
export class SqliteProjectConfigRepo implements IProjectConfigRepository {
  constructor(
    // db retained for parity with the DI container even though this repo
    // delegates to the other repos — kept so future methods that need
    // atomic transactions can grab the handle without a signature change.
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: reserved for future use
    private db: Database,
    private systemPromptRepo: ISystemPromptRepository,
    private projectRepo: IProjectRepository,
    private statusRepo: IStatusRepository,
    private settingsRepo: IProjectSettingsRepository,
    private agentRepo: IAgentRepository,
  ) {}

  async getConfig(projectId?: string): Promise<ProjectConfig> {
    const pid = projectId ?? this.projectRepo.getDefaultId()
    const project = this.projectRepo.get(pid)
    const systemPrompts = this.systemPromptRepo.listForRuntime(pid)
    const scanRoots = this.settingsRepo.getScanRoots()
    return {
      project: {
        name: project?.name,
        language: project?.language,
      },
      systemPrompts: systemPrompts.length ? systemPrompts : undefined,
      agents: this.agentRepo.listForRuntime(pid),
      statuses: this.statusRepo.list(pid),
      scanRoots: scanRoots.length ? scanRoots : undefined,
    }
  }

  async saveConfig(config: ProjectConfig, projectId?: string): Promise<void> {
    saveProjectConfigToDb(config, projectId)
  }
}
