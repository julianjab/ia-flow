export { Task } from './domain/Task.js'
export type {
  PullRequestRef,
  TaskComment,
  TaskCommentOrigin,
  TaskProps,
  TaskType,
} from './domain/Task.js'

export { Project } from './domain/Project.js'
export type {
  ProjectProps,
  ProjectSettings,
  SourceRef,
  SystemPromptRef as ProjectSystemPromptRef,
} from './domain/Project.js'

export { Repo } from './domain/Repo.js'
export type { RepoProps, SlackMemberRef } from './domain/Repo.js'

export { DomainEvent } from './events/DomainEvent.js'
export { EventBus } from './events/EventBus.js'
export type { EventHandler, Unsubscribe } from './events/EventBus.js'

export { Condition } from './rules/Condition.js'
export type { ConditionOp } from './rules/Condition.js'

export { Rule } from './rules/Rule.js'
export type { RuleProps } from './rules/Rule.js'

export { ActionRegistry } from './rules/ActionRegistry.js'

export { RuleActionEntry } from './rules/actions/RuleActionEntry.js'
export type {
  RuleActionEntryProps,
  RuleActionKind,
  RuleExecutionContext,
} from './rules/actions/RuleActionEntry.js'
export { AgentAction } from './rules/actions/AgentAction.js'
export type { AgentActionProps } from './rules/actions/AgentAction.js'
export { HttpAction } from './rules/actions/HttpAction.js'
export type { HttpActionProps } from './rules/actions/HttpAction.js'
export { EmitAction } from './rules/actions/EmitAction.js'
export type { EmitActionProps, EmitActionScope } from './rules/actions/EmitAction.js'
export { ScriptAction } from './rules/actions/ScriptAction.js'
export type { ScriptActionProps, ScriptRuntime } from './rules/actions/ScriptAction.js'
export { RefAction } from './rules/actions/RefAction.js'
export type { RefActionProps } from './rules/actions/RefAction.js'

export {
  Agent,
  SUCCESS_EXIT,
  ERROR_EXIT,
  exitSet,
  exitComment,
  resolveCommentTarget,
} from './engine/Agent.js'
export type {
  AgentDefinitionProps,
  AgentExit,
  AgentOutput,
  AgentOutputField,
  AgentProvider,
  AgentProviderChoice,
  AgentRunInput,
  AgentRunOutput,
  AgentToolEntry,
  AgentVariableValue,
  BashRunConfig,
  CommentTarget,
} from './engine/Agent.js'

export { AgentRegistry } from './engine/AgentRegistry.js'
export { Engine } from './engine/Engine.js'
