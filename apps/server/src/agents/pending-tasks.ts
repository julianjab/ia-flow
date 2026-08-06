import type { Task } from '@ia-flow/shared'
import type { TransitionManager } from '../issue-managers/transition-manager.js'

type BroadcastFn = (msg: object) => void

export interface PendingTask {
  task: Task
  manager: TransitionManager
  onFinish?: string
  onError?: string
  broadcast: BroadcastFn
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
