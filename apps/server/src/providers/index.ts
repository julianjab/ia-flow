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

// ─── Provider Config (per step type) ─────────────────────────────────────
// Stored in the SQLite DB (project_settings key: 'provider_config')

import {
  bulkSetRepos,
  dbReposToMapping,
  getDb,
  getProviderConfigFromDb,
  migrateFromProjectConfigYaml,
  migrateFromProvidersJson,
  migrateHardcodedSystemPrompts,
  migrateProvidersJsonToDb,
  seedSystemPromptIfMissing,
  setProviderConfigToDb,
} from '../db.js'
import { GENERATE_SYSTEM, REFINE_SYSTEM } from '../routes/agents.js'

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

// Initialize DB and run one-time migrations on module load.
getDb()
migrateFromProvidersJson() // 1. migrate repoMappings → repos table
migrateProvidersJsonToDb() // 2. migrate rest of providers.json → DB blob; deletes the file
migrateFromProjectConfigYaml()
migrateHardcodedSystemPrompts(
  [
    { text: "You are Claude Code, Anthropic's official CLI for Claude." },
    {
      text: 'You are a senior engineer at LaHaus, a proptech company in Latin America (Colombia, Mexico).\nLaHaus stack: Go microservices, Python FastAPI, Vue 3/Nuxt 3, PostgreSQL, Redis, AWS (SQS/S3/RDS), Snowplow events.\nArchitecture: Clean Architecture, hexagonal, dependency injection (wire for Go, injector for Python).\nReturn ONLY valid JSON — no markdown fences, no explanation text.',
    },
  ],
  ['Claude Code Identity', 'LaHaus Stack Context'],
)
seedSystemPromptIfMissing({
  id: 'iaGenerarPrompt',
  name: 'IA — Generar Prompt',
  text: GENERATE_SYSTEM,
})
seedSystemPromptIfMissing({
  id: 'iaRefinarPrompt',
  name: 'IA — Refinar Prompt',
  text: REFINE_SYSTEM,
})

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
  if (!stepCfg) {
    throw new Error(`No provider configured for step '${step}'`)
  }
  const { provider, ...overrides } = stepCfg
  return { providerId: provider, settings: { ...config.anthropicApi, ...overrides } }
}

export async function loadProviderConfig(): Promise<ProviderConfig> {
  const repoMappings = dbReposToMapping()
  const saved = getProviderConfigFromDb() ?? {}
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
    bulkSetRepos(config.repoMappings)
  }
  const { repoMappings: _ignored, ...rest } = config
  setProviderConfigToDb(rest as Record<string, unknown>)
}
