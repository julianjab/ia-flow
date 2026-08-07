import type { ProjectConfig } from '@ia-flow/shared'

export interface IProjectConfigRepository {
  getConfig(): Promise<ProjectConfig>
  saveConfig(config: ProjectConfig): Promise<void>
}
