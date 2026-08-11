import type { Task } from '@ia-flow/shared'
import type { TransitionManager } from '../issue-managers/transition-manager.js'

type BroadcastFn = (msg: object) => void

export interface PendingTask {
  task: Task
  manager: TransitionManager
  onFinish?: string
  onError?: string
  broadcast: BroadcastFn
  /** Status of the task when the agent was dispatched. If the source status
   *  drifts from this (user moved the card, external write), the polling
   *  manager treats it as a manual cancel and calls `cancel`. */
  initialStatus: string
  /** Set by the orchestrator once the provider run is in flight. Kills the
   *  underlying session/request and clears working state. Idempotent. */
  cancel?: () => Promise<void>
  /** Terminates only the underlying provider session (e.g. tmux kill-session)
   *  without touching the pending-task state or transitions. Invoked from
   *  complete_task / fail_task so the pane closes when the agent signals it
   *  is done, instead of lingering until the operator kills it. */
  killSession?: () => Promise<void>
  /** True once `cancel` has been invoked. Downstream tool callbacks (e.g.
   *  complete_task arriving from a killed tmux pane) check this to skip
   *  re-applying transitions on top of the user's new state. */
  cancelled?: boolean
}

export interface FinishResult {
  /** Snapshot of the task at the moment the pending entry was removed —
   *  reflects mutations applied by complete_task / fail_task tools. */
  task: Task
  /** True if the run was cancelled (either by the polling divergence gate
   *  or by any caller passing `{ cancelled: true }`). */
  cancelled: boolean
  /** True if a tool (complete_task / fail_task) removed the entry, meaning
   *  transitions were already applied and the orchestrator must not run its
   *  default onFinish/onError logic on top. */
  finalizedByTool: boolean
}

const pending = new Map<string, PendingTask>()
// Async-agent finish plumbing. When the orchestrator hands control to an
// async provider (tmux/iterm), provider.run returns immediately with only
// the session started. The chain-runner needs to block until the agent
// actually signals completion via complete_task / fail_task / cancel, or the
// next iteration would run in parallel on the same task.
const finishResolvers = new Map<string, (r: FinishResult) => void>()
const finishPromises = new Map<string, Promise<FinishResult>>()

export function registerPendingTask(taskId: string, info: PendingTask): void {
  pending.set(taskId, info)
  let resolve!: (r: FinishResult) => void
  const promise = new Promise<FinishResult>((r) => {
    resolve = r
  })
  finishResolvers.set(taskId, resolve)
  finishPromises.set(taskId, promise)
}

export function getPendingTask(taskId: string): PendingTask | undefined {
  return pending.get(taskId)
}

export function removePendingTask(
  taskId: string,
  finish?: { cancelled?: boolean; finalizedByTool?: boolean },
): void {
  const info = pending.get(taskId)
  pending.delete(taskId)
  const resolver = finishResolvers.get(taskId)
  finishResolvers.delete(taskId)
  finishPromises.delete(taskId)
  if (resolver && info) {
    resolver({
      task: info.task,
      cancelled: finish?.cancelled ?? info.cancelled === true,
      finalizedByTool: finish?.finalizedByTool ?? false,
    })
  }
}

/** Await the completion of a pending agent run. Returns the pre-registered
 *  promise (created by registerPendingTask) so callers that grab it right
 *  after registration will still receive the result even if the entry is
 *  removed before they await. Returns null if there is no pending entry
 *  registered under `taskId` (e.g. the run finished synchronously before
 *  the caller asked). */
export function waitForFinish(taskId: string): Promise<FinishResult> | null {
  return finishPromises.get(taskId) ?? null
}

export function listPendingTasks(): Array<[string, PendingTask]> {
  return [...pending.entries()]
}
