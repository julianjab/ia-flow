import { promptRepo, repoRepo } from '../composition/container.js'
import type {
  AnthropicApiSettings,
  ProviderConfig,
  StepType,
  TerminalProviderSettings,
} from './types.js'

export const DEFAULT_ANTHROPIC_SETTINGS: AnthropicApiSettings = {
  model: 'claude-sonnet-4-6',
  anthropicVersion: '2023-06-01',
  anthropicBeta: [
    'claude-code-20250219',
    'oauth-2025-04-20',
    'interleaved-thinking-2025-05-14',
    'context-management-2025-06-27',
    'prompt-caching-scope-2026-01-05',
    'extended-cache-ttl-2025-04-11',
  ],
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
  const repoMappings = repoRepo.toMapping()
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
    repoRepo.bulkSet(config.repoMappings)
  }
  const { repoMappings: _ignored, ...rest } = config
  promptRepo.setProviderConfigBlob(rest as Record<string, unknown>)
}
