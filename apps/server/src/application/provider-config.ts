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
  const { projectRepo, promptRepo, repoRepo } = await import('../composition/container.js')
  if (config.repoMappings) {
    // Writes go to the default project; the projects UI is the source of
    // truth for scoped edits.
    repoRepo.bulkSet(config.repoMappings, projectRepo.getDefaultId())
  }
  const { repoMappings: _ignored, ...rest } = config
  promptRepo.setProviderConfigBlob(rest as Record<string, unknown>)
}
