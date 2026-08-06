// Session Provider abstraction — configurable execution backend per pipeline step
// Similar to LangGraph nodes: each step can use a different provider
import type {
  RepoContext,
  StepType,
  AnthropicApiSettings,
  StepOverride,
  StepConfig,
  ProviderConfig,
  RepoWorkflow,
} from '@ia-flow/shared'

export type { StepType, AnthropicApiSettings, StepOverride, StepConfig, ProviderConfig, RepoWorkflow }

export interface StepInput {
  step: StepType           // which pipeline step — used to resolve per-step settings
  taskTitle: string
  taskDescription: string
  taskType: string
  repos: string[]
  contexts: RepoContext[]
  prompt: string           // the full prompt to execute
  systemPromptBlocks?: Array<{ type: 'text'; text: string }>  // extra system prompt blocks prepended before provider defaults
  tools?: string[]         // tool names the agent is allowed to use (undefined = all registered)
  githubToolContext?: { github?: import('../tools/index.js').GitHubToolContext }
  cwd?: string             // working directory (for tmux-claude)
  workflow?: RepoWorkflow  // per-repo git staging strategy: worktree | branch | main
}

export interface StepOutput {
  content: string          // generated content (PRD JSON, implementation notes, etc.)
  mode: 'api' | 'tmux'
  tmuxSession?: string     // set when mode=tmux
  attachCmd?: string       // e.g. "tmux attach -t cclaude-task-foo"
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
  if (!p) throw new Error(`Provider '${id}' not registered. Available: ${[...providers.keys()].join(', ')}`)
  return p
}

export function listProviders(): StepProvider[] {
  return [...providers.values()]
}

// ─── Provider Config (per step type) ─────────────────────────────────────
// Stored in apps/server/config/providers.json

import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { getDb, migrateFromProvidersJson, migrateFromProjectConfigYaml, migrateHardcodedSystemPrompts, seedSystemPromptIfMissing, dbReposToMapping, bulkSetRepos } from '../db.js'
import { GENERATE_SYSTEM, REFINE_SYSTEM } from '../routes/agents.js'

const CONFIG_DIR = join(import.meta.dir, '..', '..', 'config')
const CONFIG_PATH = join(CONFIG_DIR, 'providers.json')

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

const DEFAULT_CONFIG: ProviderConfig = {
  steps: {
    'refine-functional': 'anthropic-api',
    'refine-technical': 'anthropic-api',
    'implement': 'tmux-claude',
  },
  anthropicApi: DEFAULT_ANTHROPIC_SETTINGS,
  phasePrompts: {},
}

// Initialize DB and run one-time migrations on module load.
getDb()
migrateFromProvidersJson()
migrateFromProjectConfigYaml()
migrateHardcodedSystemPrompts(
  [
    { text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { text: 'You are a senior engineer at LaHaus, a proptech company in Latin America (Colombia, Mexico).\nLaHaus stack: Go microservices, Python FastAPI, Vue 3/Nuxt 3, PostgreSQL, Redis, AWS (SQS/S3/RDS), Snowplow events.\nArchitecture: Clean Architecture, hexagonal, dependency injection (wire for Go, injector for Python).\nReturn ONLY valid JSON — no markdown fences, no explanation text.' },
  ],
  ['Claude Code Identity', 'LaHaus Stack Context'],
)
seedSystemPromptIfMissing({ id: 'iaGenerarPrompt', name: 'IA — Generar Prompt',  text: GENERATE_SYSTEM })
seedSystemPromptIfMissing({ id: 'iaRefinarPrompt', name: 'IA — Refinar Prompt',  text: REFINE_SYSTEM })

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
  const { provider, ...overrides } = stepCfg
  return { providerId: provider, settings: { ...config.anthropicApi, ...overrides } }
}

export async function loadProviderConfig(): Promise<ProviderConfig> {
  const repoMappings = dbReposToMapping()
  if (!existsSync(CONFIG_PATH)) return { ...structuredClone(DEFAULT_CONFIG), repoMappings }
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8')
    const saved = JSON.parse(raw)
    return {
      steps: { ...DEFAULT_CONFIG.steps, ...(saved.steps ?? saved) },
      anthropicApi: { ...DEFAULT_ANTHROPIC_SETTINGS, ...(saved.anthropicApi ?? {}) },
      repoMappings,
      phasePrompts: { ...(DEFAULT_CONFIG.phasePrompts ?? {}), ...(saved.phasePrompts ?? {}) },
    }
  } catch {
    return { ...structuredClone(DEFAULT_CONFIG), repoMappings }
  }
}

export async function saveProviderConfig(config: ProviderConfig): Promise<void> {
  // repoMappings → DB; everything else → JSON file
  if (config.repoMappings) {
    bulkSetRepos(config.repoMappings)
  }
  const { repoMappings: _ignored, ...rest } = config
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(rest, null, 2), 'utf-8')
}

