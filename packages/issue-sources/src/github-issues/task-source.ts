import type { Task } from '@ia-flow/shared'
import type { BroadcastFn, IssueItem, TaskSource } from '../contract.js'
import { mergeSourceFieldsIntoTask } from '../dispatch/merge-source-fields.js'
import { createLogger } from '../logger.js'
import type { GitHubIssuesApi } from './api/issues-client.js'
import type { GitHubIssueSourceConfig } from './source.js'
import { StatusLabelCodec, WORKING_LABEL, withWorking } from './status-label.js'

const log = createLogger('github-issue-task-source')

/**
 * Write side for GitHubIssueSource — sibling of GitHubTaskSource
 * (github-project/task-source.ts), same shape, but every "field write" is a
 * label replace instead of a Project item-field mutation.
 */
export class GitHubIssueTaskSource implements TaskSource {
  constructor(
    private readonly config: GitHubIssueSourceConfig,
    private readonly api: GitHubIssuesApi,
    private readonly statusLabels: StatusLabelCodec,
    private readonly item: IssueItem,
    private readonly broadcast: BroadcastFn,
  ) {}

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

  /**
   * Every write below does a full-set label replace, so it MUST start from
   * the issue's current labels, not the item snapshot handed to this
   * instance at dispatch time (from a cache with up to a 60s TTL — see
   * GitHubIssueSource.fetchItems). A stale snapshot would silently drop any
   * label a human, CI, or another agent added to the issue in the meantime.
   * GitHubTaskSource (Project-based) has no equivalent risk: there, status
   * is a board field, not a label PUT that replaces the whole set.
   */
  private async freshLabels(): Promise<string[]> {
    const issue = await this.api.getByNumber(this.config.owner, this.config.repo, this.issueNumber)
    return issue?.labels ?? this.item.labels ?? []
  }

  private async persistLabels(next: string[]): Promise<void> {
    await this.api.replaceLabels(this.config.owner, this.config.repo, this.issueNumber, next)
  }

  async applyTransition(task: Task, newStatus: string): Promise<Task> {
    const next = this.statusLabels.withStatus(await this.freshLabels(), newStatus)
    await this.persistLabels(next)
    log.info({ issueId: this.issueId, newStatus }, 'GitHub issue status label updated')
    this.broadcast({ type: 'github-issue:transition', issueId: this.issueId, newStatus })
    return { ...task, status: newStatus as Task['status'], labels: next }
  }

  async setAgentWorking(task: Task, working: boolean): Promise<Task> {
    const next = withWorking(await this.freshLabels(), working)
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

  /**
   * Reemplazo: `labels` pasa a ser el set completo del issue (misma semántica
   * que GitHubTaskSource.setLabels — ver labels.ts), CON UNA EXCEPCIÓN: el
   * `anchorLabel`, el `status:*` vigente y `WORKING_LABEL` son bookkeeping
   * propio de este source, no campos que el DSL `$labels:` deba poder tocar.
   * En GitHubProjectSource ese equivalente (Status/Working) vive en campos
   * del Project, fuera del alcance de `setLabels` — acá viven en labels, así
   * que hay que blindarlos a mano: sin esto, un `$labels:=algo` disparado
   * *durante* el propio run del agente borraría el anchor (el issue
   * desaparece del engine sin forma de recuperarlo desde la app) o el
   * working flag (el próximo `runCycle` ve `working: false` y despacha un
   * segundo agente sobre la misma task).
   */
  async setLabels(task: Task, labels: string[]): Promise<Task> {
    const fresh = await this.freshLabels()
    const currentStatus = this.statusLabels.statusFromLabels(fresh)
    const next = new Set(labels)
    next.add(this.config.anchorLabel)
    if (fresh.includes(WORKING_LABEL)) next.add(WORKING_LABEL)
    if (currentStatus && this.statusLabels.statusFromLabels([...next]) === '') {
      next.add(this.statusLabels.labelFor(currentStatus))
    }
    const finalLabels = [...next]
    await this.persistLabels(finalLabels)
    log.info({ issueId: this.issueId, labels: finalLabels }, 'GitHub labels applied')
    return { ...task, labels: finalLabels }
  }

  /**
   * GitHub issues have no custom-field concept — that's a Projects v2 board
   * column, and GitHubIssueSource doesn't have a board underneath it. Left
   * `setFields` undefined (as `ITaskSource` allows, since it's optional),
   * this class was NOT substitutable for `ITaskSource` everywhere: the
   * `set_task_field` tool special-cases the absence with a hard `throw`
   * (`packages/tools/src/task/task.ts`), while `outcomes.ts`'s `$set:`
   * handler falls back to an in-memory-only merge for any manager lacking
   * `setFields` — same underlying gap, two different behaviors depending on
   * which caller you went through. Implementing it here (instead of leaving
   * it absent) closes that gap: both callers now get the same outcome.
   *
   * `Status` is the one field with something real to write to — routed
   * through `applyTransition` so it hits the same label mutation, mirroring
   * how `GitHubTaskSource.setFields` resolves "Status" to the Project's
   * Status field and performs the identical `updateItemStatus` call
   * `applyTransition` does there. Every other field name has no native
   * counterpart on a GitHub issue, so it's kept in-memory only via
   * `mergeSourceFieldsIntoTask` — the same no-op-when-unsupported precedent
   * documented for `setLabels` on sources that don't model labels natively.
   */
  async setFields(task: Task, fields: Record<string, string>): Promise<Task> {
    let result = task
    for (const [field, value] of Object.entries(fields)) {
      if (field.toLowerCase() === 'status') {
        result = await this.applyTransition(result, value)
      } else {
        log.warn(
          { issueId: this.issueId, field },
          'GitHub issues have no custom fields — value kept in-memory only',
        )
      }
    }
    return mergeSourceFieldsIntoTask(result, fields)
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
