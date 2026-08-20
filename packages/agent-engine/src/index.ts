export * from './contract.js'
export { createLogger, setLoggerFactory } from './logger.js'
export type { Logger, LoggerFactory } from './logger.js'

export { applyOutcome, condToOp, evalWhen } from './outcomes.js'

export { selectAgent, summarizeRejections } from './agent-selection.js'
export type {
  AgentSelectionInput,
  AgentSelectionResult,
  RejectedCandidate,
  RejectionReason,
} from './agent-selection.js'
export { resolveRunContext } from './run-context.js'
export type { RunContext, ResolveRunContextInput } from './run-context.js'
export {
  PendingTaskRegistry,
  pendingTaskRegistry,
  getPendingTask,
  registerPendingTask,
  removePendingTask,
  waitForFinish,
  listPendingTasks,
} from './pending-tasks.js'
export type { PendingTask, FinishResult } from './pending-tasks.js'
export { resolveVariables } from './variable-resolver.js'
export type { ResolveContext, ResolveVariable } from './variable-resolver.js'
export { watchSession } from './session-watchdog.js'
export type { WatchOptions } from './session-watchdog.js'

export {
  WorkspaceManager,
  hasWriteTools,
  branchNameFor,
  worktreePathFor,
  DEFAULT_WORKTREE_BASE,
} from './WorkspaceManager.js'
export type {
  ShellResult,
  ShellRunner,
  WorkspaceTask,
  WorkspaceAgentDef,
  ResolvedScopes,
  GetOrCreateOptions,
  ResolveScopesContext,
} from './WorkspaceManager.js'

export { buildGitContext } from './git-context.js'
export type { GitContextOptions } from './git-context.js'

export { Agent } from './Agent.js'
export type { AgentRunInput, AgentRunState, CompilePolicy } from './Agent.js'
export { AgentLifecycle } from './AgentLifecycle.js'
export { AgentOrchestrator } from './AgentOrchestrator.js'
export type { BranchNamerTaskLike, LinkedBranchNamer } from './linked-branch.js'
export { resolveSystemPromptBlocks } from './system-prompt-blocks.js'
export type { SystemPromptBlock } from './system-prompt-blocks.js'
export { TaskDispatcher } from './TaskDispatcher.js'
