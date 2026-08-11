import type { Task } from '@ia-flow/shared'
import { taskRepo } from '../../composition/container.js'
import type { TransitionManager } from '../../issue-managers/transition-manager.js'
import { createLogger } from '../../logger.js'
import { addBlockedBy } from './blocked-by.js'

const log = createLogger('local-transition-manager')

export class LocalTransitionManager implements TransitionManager {
  async applyTransition(task: Task, newStatus: string): Promise<Task> {
    return taskRepo.move(task, newStatus)
  }

  async saveOutput(task: Task, content: string): Promise<Task> {
    const updated = { ...task, description: content }
    await taskRepo.update(updated)
    return updated
  }

  async setAgentWorking(task: Task, working: boolean): Promise<Task> {
    const updated = { ...task, agent_working: working }
    await taskRepo.update(updated)
    return updated
  }

  async postError(task: Task, error: string): Promise<void> {
    await taskRepo.update({ ...task, error })
  }

  async postComment(task: Task, body: string): Promise<void> {
    const comment = { body, created_at: new Date().toISOString() }
    const updated = { ...task, comments: [...(task.comments ?? []), comment] }
    await taskRepo.update(updated)
  }

  async setFields(task: Task, fields: Record<string, string>): Promise<Task> {
    const updated = { ...task, ...fields } as Task
    await taskRepo.update(updated)
    return updated
  }

  async setLabels(task: Task, labels: string[]): Promise<Task> {
    log.info({ taskId: task.id, labels }, 'Local source has no label store — call ignored')
    return task
  }

  async markBlockedBy(task: Task, blockedIssueId: string, blockingIssueId: string): Promise<void> {
    // For local, we only own the storage when the *blocked* issue is a local
    // task in our repo. Look it up; if not found, error — the caller should
    // route the call to the source that owns the blocked issue.
    const blocked = await taskRepo.getById(blockedIssueId)
    if (!blocked) {
      throw new Error(`Local source: no task '${blockedIssueId}' — cannot mark as blocked`)
    }
    const updatedDescription = addBlockedBy(blocked.description ?? '', blockingIssueId)
    if (updatedDescription === blocked.description) {
      log.debug({ blockedIssueId, blockingIssueId }, 'Blocker already recorded — no-op')
      return
    }
    await taskRepo.update({ ...blocked, description: updatedDescription })
    log.info({ blockedIssueId, blockingIssueId }, 'Local blocked-by relation persisted')
  }
}
