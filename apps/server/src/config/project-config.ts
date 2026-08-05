import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import { ProjectConfigSchema } from '@ia-flow/shared'
import type { ProjectConfig } from '@ia-flow/shared'

export const CONFIG_DIR = join(import.meta.dir, '..', '..', 'config')
const CONFIG_PATH = join(CONFIG_DIR, 'project-config.yaml')

let cached: ProjectConfig | null | undefined = undefined

export async function getProjectConfig(): Promise<ProjectConfig | null> {
  if (cached !== undefined) return cached

  if (!existsSync(CONFIG_PATH)) {
    cached = null
    return null
  }

  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8')
    const parsed = parseYaml(raw)
    cached = ProjectConfigSchema.parse(parsed)
    return cached
  } catch (err) {
    console.error('[project-config] Failed to load:', err)
    cached = null
    return null
  }
}

export function invalidateProjectConfig(): void {
  cached = undefined
}
