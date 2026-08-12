import type {
  AnthropicApiSettings,
  ProviderConfig,
  StepType,
  TerminalProviderSettings,
} from '@ia-flow/shared'
import { ANTHROPIC_VERSION, CLAUDE_CODE_BETAS } from '../adapters/anthropic/auth.js'
import { projectRepo, promptRepo, repoRepo } from '../composition/container.js'

export const DEFAULT_ANTHROPIC_SETTINGS: AnthropicApiSettings = {
  model: 'claude-sonnet-4-6',
  anthropicVersion: ANTHROPIC_VERSION,
  anthropicBeta: [...CLAUDE_CODE_BETAS],
  systemPrompt: [],
  thinking: { type: 'adaptive' },
  stream: true,
  responseLanguage: 'español',
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalProviderSettings = {}

const DEFAULT_CONFIG: ProviderConfig = {
  steps: {
    'refine-functional': 'anthropic-api',
    'refine-technical': 'anthropic-api',
    implement: 'tmux-claude',
  },
  anthropicApi: DEFAULT_ANTHROPIC_SETTINGS,
  tmuxClaude: DEFAULT_TERMINAL_SETTINGS,
  itermClaude: DEFAULT_TERMINAL_SETTINGS,
}

// Resolves the provider id and merged settings for a given step.
// Step-level overrides take precedence over provider-level defaults.
export function resolveStepSettings(
  step: StepType,
  config: ProviderConfig,
): { providerId: string; settings: AnthropicApiSettings } {
  const stepCfg = config.steps[step]
  if (typeof stepCfg === 'string') {
    return { providerId: stepCfg, settings: config.anthropicApi }
  }
  if (!stepCfg || typeof stepCfg === 'string') {
    throw new Error(`No provider configured for step '${step}'`)
  }
  const { provider, ...overrides } = stepCfg
  return { providerId: provider, settings: { ...config.anthropicApi, ...overrides } }
}

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
