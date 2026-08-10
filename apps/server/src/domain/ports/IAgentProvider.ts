import type { AgentProviderConfig, RepoContext, RepoWorkflow, StepType } from '@ia-flow/shared'

/**
 * Input passed to a provider's run() method. Populated by AgentOrchestrator
 * before each agent invocation.
 */
export interface ProviderInput {
  step: StepType
  taskId: string
  taskTitle: string
  taskDescription: string
  taskType: string
  repos: string[]
  contexts: RepoContext[]
  prompt: string
  systemPromptBlocks?: Array<{ type: 'text'; text: string }>
  tools?: string[]
  /** @deprecated use `providerConfig.maxIters` instead */
  maxIters?: number
  providerConfig?: AgentProviderConfig
  /** Source-specific tool context, opaque to the domain. */
  sourceToolContext?: unknown
  cwd?: string
  workflow?: RepoWorkflow
}

/**
 * Result of a provider run.
 *   - Sync providers (anthropic-api) return `{ content, mode: 'api' }`.
 *   - Async providers (tmux-claude, iterm-claude) spawn a background
 *     session and return `{ content, mode: 'tmux', tmuxSession? }`. The
 *     final task transition is triggered later by the async agent via
 *     the complete_task / fail_task tools.
 */
export interface ProviderOutput {
  content: string
  mode: 'api' | 'tmux'
  tmuxSession?: string
  attachCmd?: string
  itermOpened?: boolean
}

export interface IAgentProvider {
  readonly id: string
  readonly name: string
  readonly description: string
  run(input: ProviderInput): Promise<ProviderOutput>
}
