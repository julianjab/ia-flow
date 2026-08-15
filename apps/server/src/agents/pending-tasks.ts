// Re-exports the canonical implementation from @ia-flow/agent-engine.
// Extracted there as part of the composable-engine refactor
// (docs/prd/composable-engine-refactor.md, Phase 3). `pending-tasks.ts` is
// now a proper class (`PendingTaskRegistry`) with a default shared instance
// — these bound functions all operate on that same default instance, so
// every consumer here (tools/task.ts lifecycle tools, the daemon's
// pending-task listing route, AgentOrchestrator itself) keeps observing
// identical in-flight state, unchanged from before the move.
export {
  getPendingTask,
  listPendingTasks,
  registerPendingTask,
  removePendingTask,
  waitForFinish,
  PendingTaskRegistry,
  pendingTaskRegistry,
} from '@ia-flow/agent-engine'
export type { PendingTask, FinishResult } from '@ia-flow/agent-engine'
