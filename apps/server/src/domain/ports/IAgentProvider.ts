import type { AgentProviderConfig, RepoWorkflow, StepType } from '@ia-flow/shared'

/**
 * Input passed to a provider's run() method. Populated by AgentOrchestrator
 * before each agent invocation.
 *
 * The agent learns about repos via the `{{project.repos}}` / `{{task.repos}}`
 * template variables in its prompt. `repoPaths` is the raw name→path map
 * consumed by fs tools (`read_file`, `list_dir`, `grep_files`) to resolve
 * `<repo-name>/relative/path`.
 */
export interface ProviderInput {
  step: StepType
  taskId: string
  taskTitle: string
  taskDescription: string
  taskType: string
  /** Repos linked to this task by name. */
  repos: string[]
  /** name → absolute filesystem path, wired into ToolContext.repoPaths. */
  repoPaths: Record<string, string>
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
