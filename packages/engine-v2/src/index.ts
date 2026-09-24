export { Catalog } from './shared/Catalog.js'
export type { ProjectProps, ProjectRow, ProjectSettings } from './domain/Project.js'
export { Project } from './domain/Project.js'
export type { RepoProps } from './domain/Repo.js'
export { Repo } from './domain/Repo.js'
export type {
  AgentDefinitionProps,
  AgentExit,
  AgentRow,
  AgentOutput,
  AgentOutputField,
  AgentProvider,
  AgentProviderChoiceProps,
  AgentRunContext,
  AgentRunInput,
  AgentRunOutput,
  ProviderRunOutput,
  AgentToolEntry,
  AgentVariableValue,
  BashRunConfig,
  CommentTarget,
  NoTransitionOutcome,
} from './engine/Agent.js'
export {
  Agent,
  AgentProviderChoice,
  ERROR_EXIT,
  exitComment,
  exitSet,
  NO_TRANSITION_OUTCOMES,
  resolveCommentTarget,
  SUCCESS_EXIT,
} from './engine/Agent.js'
export { AgentRunEntity } from './engine/AgentRunEntity.js'
export { Engine, MAX_EVENT_DEPTH } from './engine/Engine.js'
export type {
  DispatchOutcome,
  DispatchOutcomeKind,
  ExecutionEntity,
  ExecutionMessage,
  ExecutionProps,
  ExecutionStatus,
} from './engine/Execution.js'
export { Execution } from './engine/Execution.js'
export type { ExecutionLogProps, ExecutionLogStatus } from './engine/ExecutionLog.js'
export { ExecutionLog } from './engine/ExecutionLog.js'
export type { McpCatalogEntryProps, McpTransport } from './engine/McpCatalogEntry.js'
export { McpCatalogEntry } from './engine/McpCatalogEntry.js'
export type { Admission, AdmissionRequest, ProviderProps } from './engine/Provider.js'
export { Provider } from './engine/Provider.js'
export type { SystemPromptEntryProps } from './engine/SystemPromptEntry.js'
export { SystemPromptEntry } from './engine/SystemPromptEntry.js'
export type { ProviderKind, ToolProps } from './engine/Tool.js'
export { Tool } from './engine/Tool.js'
export type {
  WorkspacePlan,
  WorkspaceRepoRequest,
  WorkspaceRequest,
} from './engine/Workspace.js'
export { WorkspaceLayout } from './engine/Workspace.js'
export { DomainEvent } from './events/DomainEvent.js'
export type { DomainEventScope } from './events/DomainEvent.js'
export type { EventCatalog, EventType } from './events/EventCatalog.js'
export { catalogedEvent } from './events/EventCatalog.js'
export type { EventHandler, Unsubscribe } from './events/EventBus.js'
export { EventBus } from './events/EventBus.js'

export type { AgentActionProps } from './pipeline/actions/AgentAction.js'
export { AgentAction } from './pipeline/actions/AgentAction.js'
export type { EmitActionProps } from './pipeline/actions/EmitAction.js'
export { EmitAction } from './pipeline/actions/EmitAction.js'
export type { HttpActionProps } from './pipeline/actions/HttpAction.js'
export { HttpAction } from './pipeline/actions/HttpAction.js'
export type { RefActionProps } from './pipeline/actions/RefAction.js'
export { RefAction } from './pipeline/actions/RefAction.js'
export type {
  PipelineActionEntryProps,
  PipelineActionKind,
  PipelineExecutionContext,
} from './pipeline/actions/PipelineActionEntry.js'
export { PipelineActionEntry } from './pipeline/actions/PipelineActionEntry.js'
export type { ScriptActionProps, ScriptRuntime } from './pipeline/actions/ScriptAction.js'
export { ScriptAction } from './pipeline/actions/ScriptAction.js'
export type { ConditionOp } from './pipeline/Condition.js'
export { Condition } from './pipeline/Condition.js'
export type { ConditionalProps } from './pipeline/Conditional.js'
export { Conditional } from './pipeline/Conditional.js'
export type { PipelineActionRow, PipelineProps, PipelineRow } from './pipeline/Pipeline.js'
export { Pipeline } from './pipeline/Pipeline.js'

export type { PayloadWriter } from './infra/PayloadWriter.js'
export { getPayloadWriter, setPayloadWriter } from './infra/PayloadWriter.js'
export type { SecretResolver } from './infra/SecretResolver.js'
export { getSecretResolver, setSecretResolver } from './infra/SecretResolver.js'
export type { ShellRunner, ShellRunOptions, ShellRunResult } from './infra/ShellRunner.js'
export { getShellRunner, setShellRunner } from './infra/ShellRunner.js'
export type { TextClassifier } from './infra/TextClassifier.js'
export { getTextClassifier, setTextClassifier } from './infra/TextClassifier.js'
