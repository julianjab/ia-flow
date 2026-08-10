// Session Provider abstraction — configurable execution backend per pipeline step
// Similar to LangGraph nodes: each step can use a different provider
import type {
  AgentProviderConfig,
  AnthropicApiSettings,
  ProviderConfig,
  RepoContext,
  RepoWorkflow,
  StepConfig,
  StepOverride,
  StepType,
  TerminalProviderSettings,
} from '@ia-flow/shared'

export type {
  StepType,
  AnthropicApiSettings,
  TerminalProviderSettings,
  StepOverride,
  StepConfig,
  ProviderConfig,
  RepoWorkflow,
  AgentProviderConfig,
}

export interface StepInput {
  step: StepType // which pipeline step — used to resolve per-step settings
  taskId?: string // for log correlation across provider + engine
  taskTitle: string
  taskDescription: string
  taskType: string
  repos: string[]
  contexts: RepoContext[]
  prompt: string // the full prompt to execute
  systemPromptBlocks?: Array<{ type: 'text'; text: string }> // extra system prompt blocks prepended before provider defaults
  tools?: string[] // tool names the agent is allowed to use (undefined = all registered)
  githubToolContext?: { github?: import('../tools/index.js').GitHubToolContext }
  cwd?: string // working directory (for tmux-claude)
  workflow?: RepoWorkflow // per-repo git staging strategy: worktree | branch | main
  /** @deprecated use `providerConfig.maxIters` instead */
  maxIters?: number // per-agent tool loop limit; overrides provider default
  providerConfig?: AgentProviderConfig // per-agent provider settings (model, effort, flags, ...)
}

export interface StepOutput {
  content: string // generated content (PRD JSON, implementation notes, etc.)
  mode: 'api' | 'tmux'
  tmuxSession?: string // set when mode=tmux
  attachCmd?: string // e.g. "tmux attach -t cclaude-task-foo"
  itermOpened?: boolean
}

export interface StepProvider {
  id: string
  name: string
  description: string
  run(input: StepInput): Promise<StepOutput>
}

// ─── Provider Registry ─────────────────────────────────────────────────────

const providers = new Map<string, StepProvider>()

export function registerProvider(p: StepProvider): void {
  providers.set(p.id, p)
}

export function getProvider(id: string): StepProvider {
  const p = providers.get(id)
  if (!p)
    throw new Error(
      `Provider '${id}' not registered. Available: ${[...providers.keys()].join(', ')}`,
    )
  return p
}

export function listProviders(): StepProvider[] {
  return [...providers.values()]
}
import { promptRepo, repoRepo } from '../composition/container.js'
import { getDb } from '../infrastructure/db/database.js'

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
  phasePrompts: {},
}

// Ensure the DB is opened (schema migrations run inside getDb()).
getDb()

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
    phasePrompts: {
      ...(DEFAULT_CONFIG.phasePrompts ?? {}),
      ...((saved.phasePrompts as object | undefined) ?? {}),
    },
  }
}

export async function saveProviderConfig(config: ProviderConfig): Promise<void> {
  if (config.repoMappings) {
    repoRepo.bulkSet(config.repoMappings)
  }
  const { repoMappings: _ignored, ...rest } = config
  promptRepo.setProviderConfigBlob(rest as Record<string, unknown>)
}
