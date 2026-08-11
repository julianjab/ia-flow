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
  /** True once complete_task / fail_task has already driven a transition.
   *  The orchestrator's sync branch checks this before applying `onFinish`
   *  or `onError` again — otherwise a tool-supplied `status` override
   *  (e.g. epic → Blocked) gets clobbered by the default onFinish. */
  outcomeApplied?: boolean
}

const pending = new Map<string, PendingTask>()

export function registerPendingTask(taskId: string, info: PendingTask): void {
  pending.set(taskId, info)
}

export function getPendingTask(taskId: string): PendingTask | undefined {
  return pending.get(taskId)
}

export function removePendingTask(taskId: string): void {
  pending.delete(taskId)
}

export function listPendingTasks(): Array<[string, PendingTask]> {
  return [...pending.entries()]
}
