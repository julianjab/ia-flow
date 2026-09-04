import type { AgentVariableValue, RepoDef, Task, TemplateContext } from '@ia-flow/shared'

export interface ResolveContext {
  task: Task
  variables?: Record<string, AgentVariableValue>
  project?: Record<string, string>
  /** All repos configured for this task's project, resolved from IRepoRepository. */
  projectRepos?: RepoDef[]
  tools?: string[]
  context?: TemplateContext
  /** La última salida estructurada de cada agente distinto que corrió sobre
   *  esta task — lo que rinde `{{task.previous_outputs}}`. Mirrors
   *  `@ia-flow/agent-engine`'s `ResolveContext.previousOutputs`. */
  previousOutputs?: Array<{ agentId: string; structuredOutput: Record<string, unknown> }>
}
