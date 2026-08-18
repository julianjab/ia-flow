import type { Task } from '@ia-flow/shared'
import type { BroadcastFn, IssueItem, TaskSource } from '../contract.js'
import { createLogger } from '../logger.js'
import type { GitHubIssuesApi } from './api/issues-client.js'
import type { GitHubIssueSourceConfig } from './source.js'
import { StatusLabelCodec, withWorking } from './status-label.js'

const log = createLogger('github-issue-task-source')

/**
 * Write side for GitHubIssueSource — sibling of GitHubTaskSource
 * (github-project/task-source.ts), same shape, but every "field write" is a
 * label replace instead of a Project item-field mutation.
 */
export class GitHubIssueTaskSource implements TaskSource {
  private labels: string[]

  constructor(
    private readonly config: GitHubIssueSourceConfig,
    private readonly api: GitHubIssuesApi,
    private readonly statusLabels: StatusLabelCodec,
    private readonly item: IssueItem,
    private readonly broadcast: BroadcastFn,
  ) {
    this.labels = item.labels ?? []
  }

  private get issueNumber(): number {
    const n = this.item.issueNumber
    if (n == null) throw new Error(`Item ${this.item.id} missing issueNumber`)
    return n
  }

  private get issueId(): string {
    const id = this.item.meta?.issueId as string | undefined
    if (!id) throw new Error(`Item ${this.item.id} missing meta.issueId`)
    return id
  }

  private async persistLabels(next: string[]): Promise<void> {
    await this.api.replaceLabels(this.config.owner, this.config.repo, this.issueNumber, next)
    this.labels = next
  }

  async applyTransition(task: Task, newStatus: string): Promise<Task> {
    const next = this.statusLabels.withStatus(this.labels, newStatus)
    await this.persistLabels(next)
    log.info({ issueId: this.issueId, newStatus }, 'GitHub issue status label updated')
    this.broadcast({ type: 'github-issue:transition', issueId: this.issueId, newStatus })
    return { ...task, status: newStatus as Task['status'], labels: next }
  }

  async setAgentWorking(task: Task, working: boolean): Promise<Task> {
    const next = withWorking(this.labels, working)
    await this.persistLabels(next)
    log.info({ issueId: this.issueId, working }, 'Agent working label updated')
    return { ...task, labels: next }
  }

  async saveOutput(task: Task, content: string): Promise<Task> {
    await this.api.updateBody(this.issueId, content)
    log.info({ issueId: this.issueId }, 'Issue body updated')
    return { ...task, description: content }
  }

  async postError(_task: Task, error: string): Promise<void> {
    await this.api.addComment(
      this.issueId,
      `## ⚠️ Agent error\n\n\`\`\`\n${error}\n\`\`\`\n\nRevisa el error y mueve a status anterior para reintentar.`,
    )
    log.error({ issueId: this.issueId, error }, 'Error comment posted')
  }

  async postComment(_task: Task, body: string): Promise<void> {
    await this.api.addComment(this.issueId, body)
  }

  /** Reemplazo: `labels` pasa a ser el set completo del issue (misma
   * semántica que GitHubTaskSource.setLabels — ver labels.ts). */
  async setLabels(task: Task, labels: string[]): Promise<Task> {
    await this.persistLabels(labels)
    log.info({ issueId: this.issueId, labels }, 'GitHub labels applied')
    return { ...task, labels }
  }

  async getCurrentStatus(_task: Task): Promise<string | null> {
    const issue = await this.api.getByNumber(this.config.owner, this.config.repo, this.issueNumber)
    if (!issue) return null
    return this.statusLabels.statusFromLabels(issue.labels) || null
  }

  async markBlockedBy(_task: Task, blockedIssueId: string, blockingIssueId: string): Promise<void> {
    await this.api.addBlockedBy(blockedIssueId, blockingIssueId)
    log.info({ blockedIssueId, blockingIssueId }, 'GitHub blocked-by dependency added')
  }

  getLinkedBranchRef(_task: Task): { issueNodeId: string; owner: string; repoName: string } | null {
    return {
      issueNodeId: this.issueId,
      owner: this.config.owner,
      repoName: this.config.repo,
    }
  }
}
