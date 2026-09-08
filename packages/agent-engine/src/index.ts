export type { AgentRunInput, AgentRunState, CompilePolicy, SecretResolver } from './Agent.js'
export { Agent, setSecretResolver } from './Agent.js'
export { AgentLifecycle } from './AgentLifecycle.js'
export {
  AgentOrchestrator,
  MAX_RESUME_AGE_MS,
  MAX_RESUME_ATTEMPTS,
} from './AgentOrchestrator.js'
export * from './contract.js'
export type { ClassifyFailureInput } from './failure-taxonomy.js'
export { classifyFailure } from './failure-taxonomy.js'
export type { GitContextOptions } from './git-context.js'
export { buildGitContext } from './git-context.js'
export { issueRef } from './issue-ref.js'
export type { BranchNamerTaskLike, LinkedBranchNamer } from './linked-branch.js'
export type { Logger, LoggerFactory } from './logger.js'
export { createLogger, setLoggerFactory } from './logger.js'
export { applyOutcome, condToOp, evalWhen, parseFieldAssignments } from './outcomes.js'
export type {
  FinishResult,
  PendingTask,
  PendingTaskRehydrator,
  ResolvedPendingTask,
} from './pending-tasks.js'
export {
  getPendingTask,
  listPendingTasks,
  PendingTaskRegistry,
  pendingTaskRegistry,
  registerPendingTask,
  removePendingTask,
  resolvePendingTask,
  setPendingTaskRehydrator,
  waitForFinish,
} from './pending-tasks.js'
export type { ResolveRunContextInput, RunContext } from './run-context.js'
export { resolveRunContext } from './run-context.js'
export type { OutcomeEntry } from './run-outcome.js'
export { resolveExit, resolveExitCommentTarget, selectableExits } from './run-outcome.js'
export type { RunToolTelemetry, TranscriptUsage } from './run-telemetry.js'
export {
  peekRunTelemetry,
  recordHookToolResult,
  recordHookTranscript,
  resetRunTelemetry,
  setTranscriptUsageReader,
  takeRunTelemetry,
} from './run-telemetry.js'
export type { WatchOptions } from './session-watchdog.js'
export { watchSession } from './session-watchdog.js'
export type { SystemPromptBlock } from './system-prompt-blocks.js'
export { resolveSystemPromptBlocks } from './system-prompt-blocks.js'
export type { DispatchOptions } from './TaskDispatcher.js'
export { TaskDispatcher } from './TaskDispatcher.js'
export type { ResolveContext, ResolveVariable } from './variable-resolver.js'
export { resolveVariables } from './variable-resolver.js'
export type { VerifyCommandResult, VerifyRunResult } from './verify.js'
export {
  buildVerifyFailedError,
  runVerifyCommands,
  VERIFY_FAILED_MARKER,
  VERIFY_OUTPUT_MAX_BYTES,
  VERIFY_TIMEOUT_MS,
} from './verify.js'
// El ciclo de vida del worktree vive en `@ia-flow/workspace` — este paquete
// sólo aporta el permiso de escritura, que se deriva de las tools del agente.
export { hasWriteTools } from './write-access.js'
