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
  /** Agent registry id (e.g. "code-reviewer"). Propagated to logs so every
   *  event can be filtered/joined by the agent that produced it. */
  agentId?: string
  /** Project id owning the task. Propagated to logs so the Logs tab in a
   *  project view can filter by projectId. */
  projectId?: string
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
  providerConfig?: AgentProviderConfig
  /** Source-specific tool context, opaque to the domain. */
  sourceToolContext?: unknown
  cwd?: string
  workflow?: RepoWorkflow
  /** Aborts the run when triggered (e.g. the manual gate detects the source
   *  status has drifted from where the agent was dispatched). Providers
   *  should propagate to any long-running work (fetch calls, spawned
   *  sessions) and clean up so no partial transitions leak. */
  signal?: AbortSignal
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
  /** iTerm2 session unique id, set by iterm-claude when it opens a tab.
   *  Used by the orchestrator to wire `killSession` so the tab closes on
   *  cancel (status divergence) or when the agent signals completion. */
  itermSessionId?: string
  /** Sync providers set this when the run was cut short (e.g. server-side
   *  task budget exhausted, or the internal safety cap tripped). The
   *  orchestrator treats truncated runs as recoverable — it posts a
   *  progress notice instead of running the onFinish transition. */
  truncated?: boolean
  /** Underlying model stop_reason (`end_turn`, `pause_turn`, `max_tokens`,
   *  `hard_iter_cap`, …). Used for observability. */
  stopReason?: string
}

export interface IAgentProvider {
  readonly id: string
  readonly name: string
  readonly description: string
  run(input: ProviderInput): Promise<ProviderOutput>
}
