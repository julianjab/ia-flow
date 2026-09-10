import {
  DEFAULT_ANTHROPIC_SETTINGS,
  DEFAULT_PROVIDER_CONFIG as DEFAULT_CONFIG,
  DEFAULT_TERMINAL_SETTINGS,
  resolveStepSettings,
} from '@ia-flow/ai-providers'
import type { ProviderConfig } from '@ia-flow/shared'

export { DEFAULT_ANTHROPIC_SETTINGS, DEFAULT_TERMINAL_SETTINGS, resolveStepSettings }

export async function loadProviderConfig(): Promise<ProviderConfig> {
  // Dynamic import to avoid a static cycle with composition/container.ts,
  // que instancia AssistWithAiUseCase — que a su vez importa este módulo
  // para `loadProviderConfig`. Mismo patrón (y mismo motivo) que
  // `AssistWithAiUseCase.runToolAware` con `anthropicApiProvider`: un import
  // estático acá + container.ts instanciando AssistWithAiUseCase arriba de
  // este archivo en el mismo módulo es un ciclo real que sólo no explota por
  // el orden de evaluación — cualquier test que importe SOLO
  // AssistWithAiUseCase.ts (sin pasar antes por otro módulo que ya haya
  // resuelto el ciclo) lo dispara con un TDZ ReferenceError.
  const { projectRepo, promptRepo, repoRepo } = await import('../composition/container.js')
  // Legacy: provider config used to own repoMappings globally. We now scope
  // repos per-project, but keep `repoMappings` in the returned config for
  // back-compat with the providers UI. It reflects the default project only.
  // A fresh deploy with zero projects has no default to reflect — {} is the
  // correct answer, not a crash.
  const defaultProjectId = projectRepo.getDefaultId()
  const repoMappings = defaultProjectId ? repoRepo.toMapping(defaultProjectId) : {}
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
  const { projectRepo, promptRepo, repoRepo } = await import('../composition/container.js')
  if (config.repoMappings && Object.keys(config.repoMappings).length > 0) {
    // Writes go to the default project; the projects UI is the source of
    // truth for scoped edits. No default project yet (zero-project deploy)
    // means there's nowhere to write these — drop them rather than crash;
    // the rest of the config (steps, anthropicApi, ...) still saves.
    const defaultProjectId = projectRepo.getDefaultId()
    if (defaultProjectId) repoRepo.bulkSet(config.repoMappings, defaultProjectId)
  }
  const { repoMappings: _ignored, ...rest } = config
  promptRepo.setProviderConfigBlob(rest as Record<string, unknown>)
}
