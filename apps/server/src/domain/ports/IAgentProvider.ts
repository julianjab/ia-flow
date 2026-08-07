import type { AgentProviderConfig, RepoContext, RepoWorkflow } from '@ia-flow/shared'
import type { GitHubToolContext } from './ITool.js'

export type { GitHubToolContext }

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
  githubToolContext?: { github?: GitHubToolContext }
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
