import type { ProjectConfig } from '@ia-flow/shared'
import { getProjectConfigFromDb } from '../db.js'

export async function getProjectConfig(): Promise<ProjectConfig | null> {
  const config = getProjectConfigFromDb()
  if (!config.agents?.length && !config.statuses?.length) return null
  return config
}

// No-op: config is always read fresh from DB
export function invalidateProjectConfig(): void {}
