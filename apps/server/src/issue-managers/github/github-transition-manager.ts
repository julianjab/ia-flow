import type { Task } from '@ia-flow/shared'
import type { TransitionManager } from '../transition-manager.js'
import type { BroadcastFn } from '../types.js'
import { updateItemStatus, updateIssueBody, addIssueComment, clearItemWorking, type ProjectMeta } from '../../github/project.js'
import { prdJsonToMarkdown, buildRefinedBody } from './prd-formatter.js'
import { createLogger } from '../../logger.js'
import { buildProjectContext } from './project-context.js'

const log = createLogger('github-transition-manager')

export class GitHubTransitionManager implements TransitionManager {
  constructor(
    private readonly meta: ProjectMeta,
    private readonly itemId: string,
    private readonly issueId: string,
    private readonly originalBody: string,
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
    // If the agent produced PRD JSON, convert it to markdown before writing to the issue body
    let body = content
    if (content.trimStart().startsWith('{') || content.trimStart().startsWith('[')) {
      try {
        const prdMd = prdJsonToMarkdown(content, task.type)
        const cleanBase = this.originalBody.split('\n\n---\n\n')[0].trim()
        body = buildRefinedBody(cleanBase, prdMd)
      } catch {
        // Not valid PRD JSON — use content as-is
      }
    }
    await updateIssueBody(this.issueId, body)
    log.info({ issueId: this.issueId }, 'Issue body updated')
    return { ...task, description: body }
  }

  async postError(task: Task, error: string): Promise<void> {
    await addIssueComment(
      this.issueId,
      `## ⚠️ Agent error\n\n\`\`\`\n${error}\n\`\`\`\n\nRevisa el error y mueve a status anterior para reintentar.`,
    )
    log.error({ issueId: this.issueId, error }, 'Error comment posted')
  }

  async postComment(_task: Task, body: string): Promise<void> {
    await addIssueComment(this.issueId, body)
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
