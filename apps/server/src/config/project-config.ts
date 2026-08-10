import type { ProjectConfig } from '@ia-flow/shared'
import { configRepo } from '../composition/container.js'

export async function getProjectConfig(): Promise<ProjectConfig | null> {
  const config = await configRepo.getConfig()
  if (!config.agents?.length && !config.statuses?.length) return null
  return config
}

// No-op: config is always read fresh from DB
export function invalidateProjectConfig(): void {}
