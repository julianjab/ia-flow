import type { Task } from '@ia-flow/shared'
import type { TransitionManager } from '../transition-manager.js'
import { moveTask, updateTask } from '../../store.js'

export class LocalTransitionManager implements TransitionManager {
  async applyTransition(task: Task, newStatus: string): Promise<Task> {
    return moveTask(task, newStatus)
  }

  async saveOutput(task: Task, content: string): Promise<Task> {
    const updated = { ...task, description: content }
    await updateTask(updated)
    return updated
  }

  async setAgentWorking(task: Task, working: boolean): Promise<Task> {
    const updated = { ...task, agent_working: working }
    await updateTask(updated)
    return updated
  }

  async postError(task: Task, error: string): Promise<void> {
    await updateTask({ ...task, error })
  }

  async postComment(task: Task, body: string): Promise<void> {
    const comment = { body, created_at: new Date().toISOString() }
    const updated = { ...task, comments: [...(task.comments ?? []), comment] }
    await updateTask(updated)
  }
}
