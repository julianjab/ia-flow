import type {
  AgentVariableValue,
  RepoContext,
  RepoDef,
  Task,
  TemplateContext,
} from '@ia-flow/shared'

export interface ResolveContext {
  task: Task
  variables?: Record<string, AgentVariableValue>
  reposContext?: string
  repos?: RepoContext[]
  project?: Record<string, string>
  /** All repos configured for this task's project, resolved from IRepoRepository. */
  projectRepos?: RepoDef[]
  tools?: string[]
  context?: TemplateContext
}
