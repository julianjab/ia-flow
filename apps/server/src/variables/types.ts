import type { AgentVariableValue, RepoContext, Task, TemplateContext } from '@ia-flow/shared'

export interface ResolveContext {
  task: Task
  variables?: Record<string, AgentVariableValue>
  reposContext?: string
  repos?: RepoContext[]
  project?: Record<string, string>
  tools?: string[]
  context?: TemplateContext
}
