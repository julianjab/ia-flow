import type { Task } from '@ia-flow/shared'
import { addLabelsToIssue } from '../../github/labels.js'
import {
  type ProjectMeta,
  addIssueComment,
  clearItemWorking,
  updateIssueBody,
  updateItemStatus,
} from '../../github/project.js'
import { createLogger } from '../../logger.js'
import type { TransitionManager } from '../transition-manager.js'
import type { BroadcastFn } from '../types.js'
import { buildProjectContext } from './project-context.js'

const log = createLogger('github-transition-manager')

export class GitHubTransitionManager implements TransitionManager {
  constructor(
    private readonly meta: ProjectMeta,
    private readonly itemId: string,
    private readonly issueId: string,
    private readonly broadcast: BroadcastFn,
    private readonly repoName?: string,
    private readonly issueNumber?: number,
  ) {}

  async applyTransition(task: Task, newStatus: string): Promise<Task> {
    const statusField = this.meta.fields['Status']
    if (statusField) {
      await updateItemStatus(this.meta.projectId, this.itemId, statusField, newStatus)
    }
    log.info({ issueId: this.issueId, newStatus }, 'GitHub status updated')
    this.broadcast({ type: 'github:transition', issueId: this.issueId, newStatus })
    return { ...task, status: newStatus as Task['status'] }
  }

  async setAgentWorking(task: Task, working: boolean): Promise<Task> {
    const workingField = this.meta.fields['Working']
    if (!workingField) return task
    if (working) {
      await updateItemStatus(this.meta.projectId, this.itemId, workingField, 'Yes')
    } else {
      await clearItemWorking(this.meta.projectId, this.itemId, workingField)
    }
    log.info({ issueId: this.issueId, working }, 'Agent working flag updated')
    return task
  }

  async saveOutput(task: Task, content: string): Promise<Task> {
    await updateIssueBody(this.issueId, content)
    log.info({ issueId: this.issueId }, 'Issue body updated')
    return { ...task, description: content }
  }

  async postError(task: Task, error: string): Promise<void> {
    await addIssueComment(
      this.issueId,
      `## ⚠️ Agent error\n\n\`\`\`\n${error}\n\`\`\`\n\nRevisa el error y mueve a status anterior para reintentar.`,
    )
    log.error({ issueId: this.issueId, error }, 'Error comment posted')
  }

  async setFields(task: Task, fields: Record<string, string>): Promise<Task> {
    await Promise.all(
      Object.entries(fields).map(async ([field, value]) => {
        const projectField = Object.entries(this.meta.fields).find(
          ([name]) => name.toLowerCase() === field.toLowerCase(),
        )?.[1]
        if (projectField) {
          await updateItemStatus(this.meta.projectId, this.itemId, projectField, value)
          log.info({ issueId: this.issueId, field, value }, 'GitHub project field updated')
        } else {
          log.warn(
            { issueId: this.issueId, field },
            'Field not found in project meta — skipping GitHub update',
          )
        }
      }),
    )
    return { ...task, ...fields } as Task
  }

  async postComment(_task: Task, body: string): Promise<void> {
    await addIssueComment(this.issueId, body)
  }

  async setLabels(task: Task, labels: string[]): Promise<Task> {
    if (!this.repoName || this.issueNumber == null) {
      throw new Error('GitHubTransitionManager: repoName and issueNumber required to set labels')
    }
    await addLabelsToIssue(this.meta.owner, this.repoName, this.issueNumber, labels)
    log.info({ issueId: this.issueId, labels }, 'GitHub labels applied')
    return task
  }

  getProjectContext(): Record<string, string> {
    return buildProjectContext(this.meta)
  }

  getGitHubToolContext() {
    return {
      owner: this.meta.owner,
      projectId: this.meta.projectId,
      fields: this.meta.fields,
      itemId: this.itemId,
      issueId: this.issueId,
      ...(this.repoName && { repoName: this.repoName }),
      ...(this.issueNumber != null && { issueNumber: this.issueNumber }),
    }
  }
}
