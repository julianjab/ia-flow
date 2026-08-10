import type { AgentProviderConfig, RepoContext, RepoWorkflow } from '@ia-flow/shared'

export interface ProviderInput {
  step: string
  taskId: string
  taskTitle?: string
  taskDescription?: string
  taskType?: string
  repos?: string[]
  contexts?: RepoContext[]
  prompt: string
  systemPromptBlocks?: Array<{ type: 'text'; text: string }>
  tools?: string[]
  maxIters?: number
  providerConfig?: AgentProviderConfig
  /** Source-specific tool context, opaque to the domain. Populated from `ITransitionManager.getSourceToolContext()`. */
  sourceToolContext?: unknown
  cwd?: string
  workflow?: RepoWorkflow
}

export type ProviderOutput =
  | { mode: 'sync'; result?: string }
  | { mode: 'tmux'; tmuxSession: string }

export interface IAgentProvider {
  readonly id: string
  readonly name: string
  readonly description: string
  run(input: ProviderInput): Promise<ProviderOutput>
}
