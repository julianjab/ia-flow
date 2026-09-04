import type { CommentTarget, Task } from '@ia-flow/shared'
import type { ITaskRepository, TaskSource } from '../contract.js'
import { applyMultiValueOps, isMultiValueField } from '../dispatch/field-ops.js'
import { mergeSourceFieldsIntoTask } from '../dispatch/merge-source-fields.js'
import { createLogger } from '../logger.js'
import { addBlockedBy, addBlocks } from './blocked-by.js'

const log = createLogger('local-task-source')

export class LocalTaskSource implements TaskSource {
  constructor(private readonly taskRepo: ITaskRepository) {}

  async applyTransition(task: Task, newStatus: string): Promise<Task> {
    return this.taskRepo.move(task, newStatus)
  }

  async saveOutput(task: Task, content: string): Promise<Task> {
    const updated = { ...task, description: content }
    await this.taskRepo.update(updated)
    return updated
  }

  async setAgentWorking(task: Task, working: boolean): Promise<Task> {
    const updated = { ...task, agent_working: working }
    await this.taskRepo.update(updated)
    return updated
  }

  async postError(task: Task, error: string): Promise<void> {
    await this.taskRepo.update({ ...task, error })
  }

  async postComment(task: Task, body: string, target?: CommentTarget): Promise<void> {
    // `none` no tiene un lugar distinto para un source sin PR/issue separado
    // — la única forma de respetarlo es no escribir nada, igual que hace
    // `postToTarget` para GitHub.
    if (target === 'none') return
    const comment = { body, created_at: new Date().toISOString() }
    const updated = { ...task, comments: [...(task.comments ?? []), comment] }
    await this.taskRepo.update(updated)
  }

  async setFields(task: Task, fields: Record<string, string>): Promise<Task> {
    // El source local no tiene store de labels aparte: `Labels` vive en la
    // propia task, así que resolver las ops es simplemente recalcular el
    // array. Se separa del merge porque su `value` son tokens con signo, no
    // un valor a asignar.
    const plainFields: Record<string, string> = {}
    let labels: string[] | undefined
    for (const [field, value] of Object.entries(fields)) {
      if (isMultiValueField(field)) labels = applyMultiValueOps(task.labels ?? [], value)
      else plainFields[field] = value
    }
    const merged = mergeSourceFieldsIntoTask(task, plainFields)
    const updated = labels ? { ...merged, labels } : merged
    await this.taskRepo.update(updated)
    return updated
  }

  async getCurrentStatus(task: Task): Promise<string | null> {
    const fresh = await this.taskRepo.getById(task.id)
    return fresh?.status ?? null
  }

  /** Primitiva de bajo nivel — el camino normal es
   *  `setFields({ Labels: '+a,-b' })`, que persiste en la propia task. */
  async setLabels(task: Task, labels: string[]): Promise<Task> {
    const updated = { ...task, labels }
    await this.taskRepo.update(updated)
    return updated
  }

  async markBlockedBy(task: Task, blockedIssueId: string, blockingIssueId: string): Promise<void> {
    // For local, both sides of the relation live as markdown sections:
    //   · Blocked issue: `## Blocked by` gains blockingIssueId.
    //   · Blocking issue: `## Blocks` gains blockedIssueId (mirror).
    // The blocked side is required; the blocking side is best-effort so a
    // cross-source blocker (id that doesn't live in the local repo) still
    // works.
    const blocked = await this.taskRepo.getById(blockedIssueId)
    if (!blocked) {
      throw new Error(`Local source: no task '${blockedIssueId}' — cannot mark as blocked`)
    }
    const updatedBlockedDescription = addBlockedBy(blocked.description ?? '', blockingIssueId)
    if (updatedBlockedDescription !== blocked.description) {
      await this.taskRepo.update({ ...blocked, description: updatedBlockedDescription })
      log.info({ blockedIssueId, blockingIssueId }, 'Local blocked-by relation persisted')
    } else {
      log.debug({ blockedIssueId, blockingIssueId }, 'Blocker already recorded — no-op')
    }

    const blocking = await this.taskRepo.getById(blockingIssueId)
    if (!blocking) {
      log.debug(
        { blockingIssueId },
        'Blocking task not in local repo — skipping mirror Blocks section',
      )
      return
    }
    const updatedBlockingDescription = addBlocks(blocking.description ?? '', blockedIssueId)
    if (updatedBlockingDescription !== blocking.description) {
      await this.taskRepo.update({ ...blocking, description: updatedBlockingDescription })
      log.info({ blockedIssueId, blockingIssueId }, 'Local Blocks mirror persisted')
    }
  }
}
