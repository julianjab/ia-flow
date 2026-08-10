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
  AgentProviderConfig,
  AnthropicApiSettings,
  ProviderConfig,
  RepoWorkflow,
  StepConfig,
  StepOverride,
  StepType,
  TerminalProviderSettings,
}

export interface StepInput {
  step: StepType
  taskId?: string
  taskTitle: string
  taskDescription: string
  taskType: string
  repos: string[]
  contexts: RepoContext[]
  prompt: string
  systemPromptBlocks?: Array<{ type: 'text'; text: string }>
  tools?: string[]
  githubToolContext?: { github?: import('../tools/index.js').GitHubToolContext }
  cwd?: string
  workflow?: RepoWorkflow
  /** @deprecated use `providerConfig.maxIters` instead */
  maxIters?: number
  providerConfig?: AgentProviderConfig
}

export interface StepOutput {
  content: string
  mode: 'api' | 'tmux'
  tmuxSession?: string
  attachCmd?: string
  itermOpened?: boolean
}

export interface StepProvider {
  id: string
  name: string
  description: string
  run(input: StepInput): Promise<StepOutput>
}
