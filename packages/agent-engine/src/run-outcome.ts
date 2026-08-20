// Consolidates the "apply an outcome transition + broadcast task:updated"
// pattern that used to repeat inline at every finalize point in
// AgentOrchestrator (success, truncated-pause, terminal error). Kept as two
// functions (not one) because success and error outcomes are triggered by
// different conditions and error carries an optional `error` field injected
// onto the task before the transition runs.
import type { ITaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { applyOutcome } from './outcomes.js'

export interface OutcomeEntry {
  onFinish?: string
  onError?: string
}

type BroadcastFn = (msg: object) => void

export async function applySuccessOutcome(
  task: Task,
  entry: OutcomeEntry,
  manager: ITaskSource,
  broadcast: BroadcastFn,
): Promise<Task> {
  if (entry.onFinish) {
    task = await applyOutcome(task, entry.onFinish, manager)
    broadcast({ type: 'task:updated', task })
  }
  return task
}

/**
 * Runs onError, with `errMsg` injected onto the task as `.error` when
 * provided (matching the two original call sites).
 * Callers remain responsible for any pre-transition notification
 * (postComment / postError) — those differ in placement between call sites
 * and are NOT folded in here.
 */
export async function applyErrorOutcome(
  task: Task,
  entry: OutcomeEntry,
  manager: ITaskSource,
  broadcast: BroadcastFn,
  errMsg?: string,
): Promise<Task> {
  if (entry.onError) {
    const input = errMsg !== undefined ? ({ ...task, error: errMsg } as Task) : task
    task = await applyOutcome(input, entry.onError, manager)
    broadcast({ type: 'task:updated', task })
  }
  return task
}
