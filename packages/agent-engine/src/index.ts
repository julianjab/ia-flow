export * from './contract.js'
export { createLogger, setLoggerFactory } from './logger.js'
export type { Logger, LoggerFactory } from './logger.js'

export { applyOutcome, condToOp, evalWhen, parseFieldAssignments } from './outcomes.js'

export { selectAgent, selectAgentCandidates, summarizeRejections } from './agent-selection.js'
export type {
  AgentCandidatesResult,
  AgentSelectionInput,
  AgentSelectionResult,
  RejectedCandidate,
  RejectionReason,
} from './agent-selection.js'
export { clearAgentTextVerdicts, selectAgentGated } from './agent-text-gate.js'
export type { AgentTextClassifier, GatedAgentSelectionInput } from './agent-text-gate.js'
export { resolveRunContext } from './run-context.js'
export type { RunContext, ResolveRunContextInput } from './run-context.js'
export {
  PendingTaskRegistry,
  pendingTaskRegistry,
  getPendingTask,
  resolvePendingTask,
  setPendingTaskRehydrator,
  registerPendingTask,
  removePendingTask,
  waitForFinish,
  listPendingTasks,
} from './pending-tasks.js'
export type {
  PendingTask,
  FinishResult,
  PendingTaskRehydrator,
  ResolvedPendingTask,
} from './pending-tasks.js'
export { resolveVariables } from './variable-resolver.js'
export type { ResolveContext, ResolveVariable } from './variable-resolver.js'
export { watchSession } from './session-watchdog.js'
export type { WatchOptions } from './session-watchdog.js'

// El ciclo de vida del worktree vive en `@ia-flow/workspace` — este paquete
// sólo aporta el permiso de escritura, que se deriva de las tools del agente.
export { hasWriteTools } from './write-access.js'

export { buildGitContext } from './git-context.js'
export type { GitContextOptions } from './git-context.js'

export {
  recordHookToolResult,
  peekRunTelemetry,
  takeRunTelemetry,
  resetRunTelemetry,
} from './run-telemetry.js'
export type { RunToolTelemetry } from './run-telemetry.js'
export { classifyFailure } from './failure-taxonomy.js'
export type { ClassifyFailureInput } from './failure-taxonomy.js'
export { Agent, setSecretResolver } from './Agent.js'
export type { AgentRunInput, AgentRunState, CompilePolicy, SecretResolver } from './Agent.js'
export { AgentLifecycle } from './AgentLifecycle.js'
export { AgentOrchestrator } from './AgentOrchestrator.js'
export type { BranchNamerTaskLike, LinkedBranchNamer } from './linked-branch.js'
export { resolveSystemPromptBlocks } from './system-prompt-blocks.js'
export type { SystemPromptBlock } from './system-prompt-blocks.js'
export { TaskDispatcher } from './TaskDispatcher.js'
