import {
  DEFAULT_ANTHROPIC_SETTINGS,
  DEFAULT_PROVIDER_CONFIG as DEFAULT_CONFIG,
  DEFAULT_TERMINAL_SETTINGS,
  resolveStepSettings,
} from '@ia-flow/ai-providers'
import type { ProviderConfig } from '@ia-flow/shared'
import { projectRepo, promptRepo, repoRepo } from '../composition/container.js'

export { DEFAULT_ANTHROPIC_SETTINGS, DEFAULT_TERMINAL_SETTINGS, resolveStepSettings }

export async function loadProviderConfig(): Promise<ProviderConfig> {
  // Legacy: provider config used to own repoMappings globally. We now scope
  // repos per-project, but keep `repoMappings` in the returned config for
  // back-compat with the providers UI. It reflects the default project only.
  const repoMappings = repoRepo.toMapping(projectRepo.getDefaultId())
  const saved = promptRepo.getProviderConfigBlob() ?? {}
  return {
    steps: { ...DEFAULT_CONFIG.steps, ...(saved.steps ?? {}) },
    anthropicApi: {
      ...DEFAULT_ANTHROPIC_SETTINGS,
      ...((saved.anthropicApi as object | undefined) ?? {}),
    },
    tmuxClaude: {
      ...DEFAULT_TERMINAL_SETTINGS,
      ...((saved.tmuxClaude as object | undefined) ?? {}),
    },
    itermClaude: {
      ...DEFAULT_TERMINAL_SETTINGS,
      ...((saved.itermClaude as object | undefined) ?? {}),
    },
    repoMappings,
  }
}

export async function saveProviderConfig(config: ProviderConfig): Promise<void> {
  if (config.repoMappings) {
    // Writes go to the default project; the projects UI is the source of
    // truth for scoped edits.
    repoRepo.bulkSet(config.repoMappings, projectRepo.getDefaultId())
  }
  const { repoMappings: _ignored, ...rest } = config
  promptRepo.setProviderConfigBlob(rest as Record<string, unknown>)
}
