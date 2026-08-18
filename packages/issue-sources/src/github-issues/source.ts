import { invalidateMemoized, memoize } from '@ia-flow/shared'
import type {
  BroadcastFn,
  CreateItemInput,
  IssueItem,
  ProjectSource,
  SourceHealth,
  SourceItem,
  StatusOption,
  TaskSource,
  UpdateItemInput,
  WebhookMatchHint,
} from '../contract.js'
import { createLogger } from '../logger.js'
import { GitHubIssuesApi, type RestIssue } from './api/issues-client.js'
import { StatusLabelCodec, WORKING_LABEL, withWorking } from './status-label.js'
import { GitHubIssueTaskSource } from './task-source.js'

const log = createLogger('github-issue-source')

const ITEMS_TTL_MS = 60 * 1000
const bypassOnRefresh = (opts?: { refresh?: boolean }) => opts?.refresh === true

export interface GitHubIssueSourceConfig {
  owner: string
  repo: string
  /** Only issues carrying this label are visible to the engine — without it
   * every open issue in the repo would be a candidate. */
  anchorLabel: string
}

/**
 * ProjectSource over plain GitHub issues in one repo — no Projects v2 board
 * required. Sibling of GitHubProjectSource (github-project/source.ts), not a
 * subclass: the two barely share behavior (status comes from a Project
 * Single-Select field there, from a label here), so inheritance would just be
 * empty overrides. What they DO share — issue-level REST/GraphQL calls
 * (comments, body, blockers, labels, linked branches) — lives in
 * github-project/api/* already and is reused directly by GitHubIssuesApi.
 */
export class GitHubIssueSource implements ProjectSource {
  readonly kind = 'github-issues'

  constructor(
    private readonly config: GitHubIssueSourceConfig,
    private readonly api: GitHubIssuesApi = new GitHubIssuesApi(),
    private readonly statusLabels: StatusLabelCodec = new StatusLabelCodec(),
  ) {}

  @memoize({ ttlMs: ITEMS_TTL_MS, key: () => 'items', bypass: bypassOnRefresh })
  private async fetchItems(_opts?: { refresh?: boolean }): Promise<SourceItem[]> {
    const { owner, repo, anchorLabel } = this.config
    const issues = await this.api.listByLabel(owner, repo, anchorLabel, 'open')
    return issues.map((issue) => this.toSourceItem(issue))
  }

  private toSourceItem(issue: RestIssue): SourceItem {
    const { owner, repo } = this.config
    return {
      id: issue.id,
      title: issue.title,
      status: this.statusLabels.statusFromLabels(issue.labels),
      repos: repo,
      url: issue.url,
      meta: {
        issueId: issue.id,
        issueNumber: issue.number,
        repoName: repo,
        owner,
        issueUrl: issue.url,
        issueBody: issue.body,
        labels: issue.labels,
        assignees: issue.assignees,
        working: issue.labels.includes(WORKING_LABEL),
      },
    }
  }

  /** No Project board to enumerate a Status field from — the available
   * statuses are whatever status labels exist on the repo, per the injected
   * StatusLabelCodec's prefix (not a hardcoded 'status:'). */
  async getStatuses(): Promise<StatusOption[]> {
    const labels = await this.api.listRepoLabels(this.config.owner, this.config.repo)
    return this.statusLabels.statusesFromCatalog(labels).map((name) => ({ name }))
  }

  async getItems(opts?: { status?: string; refresh?: boolean }): Promise<SourceItem[]> {
    const items = await this.fetchItems({ refresh: opts?.refresh })
    if (!opts?.status) return items
    const wanted = opts.status.toLowerCase()
    return items.filter((i) => i.status.toLowerCase() === wanted)
  }

  async getItemById(id: string): Promise<SourceItem | null> {
    const items = await this.getItems()
    return items.find((i) => i.id === id) ?? null
  }

  toIssueItem(item: SourceItem): IssueItem {
    const meta = item.meta ?? {}
    const rawBody = (meta.issueBody as string | undefined) ?? ''
    // Same convention as GitHubProjectSource: strip any prior AI history the
    // daemon appended after the first "---" separator.
    const description = rawBody.split('\n\n---\n\n')[0].trim()
    return {
      id: item.id,
      title: item.title,
      description,
      type: '',
      repos: [this.config.repo],
      status: item.status,
      agentWorking: meta.working === true,
      issueNumber: meta.issueNumber as number | undefined,
      issueUrl: meta.issueUrl as string | undefined,
      labels: (meta.labels as string[] | undefined) ?? [],
      assignees: (meta.assignees as string[] | undefined) ?? [],
      meta,
    }
  }

  async loadComments(item: IssueItem): Promise<Array<{ body: string; created_at: string }>> {
    const issueId = item.meta?.issueId as string | undefined
    if (!issueId) return []
    try {
      const raw = await this.api.listComments(issueId)
      return raw.map((c) => ({ body: c.body, created_at: c.created_at }))
    } catch (err) {
      log.warn({ err: (err as Error).message, issueId }, 'loadComments failed — returning empty')
      return []
    }
  }

  async getBlockers(item: IssueItem) {
    const issueNumber = item.issueNumber
    if (issueNumber == null) return []
    const { owner, repo } = this.config
    try {
      const blockers = await this.api.getBlockers(owner, repo, issueNumber)
      return blockers
        .filter((b) => b.state !== 'closed')
        .map((b) => ({
          id: `${owner}/${repo}#${b.number}`,
          ref: `#${b.number}`,
          title: b.title,
          status: b.state,
          url: `https://github.com/${owner}/${repo}/issues/${b.number}`,
        }))
    } catch (err) {
      log.warn(
        { err: (err as Error).message, issueNumber },
        'getBlockers failed — treating as no blockers',
      )
      return []
    }
  }

  getTransitionManager(item: IssueItem, broadcast: BroadcastFn): TaskSource {
    return new GitHubIssueTaskSource(this.config, this.api, this.statusLabels, item, broadcast)
  }

  async createItem(input: CreateItemInput): Promise<SourceItem> {
    const { owner, repo, anchorLabel } = this.config
    const created = await this.api.create(owner, repo, input.title, input.description ?? '')
    const labels = input.status
      ? [anchorLabel, this.statusLabels.labelFor(input.status)]
      : [anchorLabel]
    await this.api.replaceLabels(owner, repo, created.number, labels)
    invalidateMemoized(this, 'fetchItems')
    return this.toSourceItem({ ...created, labels })
  }

  async updateItem(id: string, patch: UpdateItemInput): Promise<SourceItem> {
    const current = await this.getItemById(id)
    if (!current) throw new Error(`Item '${id}' not found`)
    const { owner, repo } = this.config
    const issueNumber = current.meta?.issueNumber as number
    if (patch.status) {
      // Re-read from GitHub, not `current.meta.labels` — that came from
      // fetchItems' memoized cache (up to 60s stale). A replace built off it
      // would drop any label added elsewhere in that window, same failure
      // mode fixed in GitHubIssueTaskSource.freshLabels.
      const fresh = await this.api.getByNumber(owner, repo, issueNumber)
      const freshLabels = fresh?.labels ?? (current.meta?.labels as string[] | undefined) ?? []
      const nextLabels = this.statusLabels.withStatus(freshLabels, patch.status)
      await this.api.replaceLabels(owner, repo, issueNumber, nextLabels)
    }
    if (patch.description !== undefined) {
      await this.api.updateBody(current.meta?.issueId as string, patch.description)
    }
    invalidateMemoized(this, 'fetchItems')
    const refreshed = await this.getItemById(id)
    return refreshed ?? current
  }

  // Crash-recovery: any issue left with the Working label from a previous run
  // gets it cleared so poll() doesn't skip it forever.
  async onDaemonStart(): Promise<void> {
    const { owner, repo, anchorLabel } = this.config
    try {
      const issues = await this.api.listByLabel(owner, repo, anchorLabel, 'open')
      const stuck = issues.filter((i) => i.labels.includes(WORKING_LABEL))
      if (!stuck.length) return
      log.info({ owner, repo, count: stuck.length }, 'Resetting stuck agent_working labels')
      await Promise.all(
        stuck.map((i) =>
          this.api.replaceLabels(owner, repo, i.number, withWorking(i.labels, false)).catch(() => {
            /* non-fatal */
          }),
        ),
      )
    } catch (err) {
      log.warn({ err, owner, repo }, 'onDaemonStart failed — will retry on first poll')
    }
  }

  // Webhook routing: `issues`/`issue_comment` deliveries only carry the repo,
  // so match on owner+repo — good enough, a spurious scan is cheap.
  async matchesWebhook(hint: WebhookMatchHint): Promise<boolean> {
    if (!hint.repoFullName) return true
    const [owner, repo] = hint.repoFullName.split('/')
    return (
      (owner ?? '').toLowerCase() === this.config.owner.toLowerCase() &&
      (repo ?? '').toLowerCase() === this.config.repo.toLowerCase()
    )
  }

  async getHealth(): Promise<SourceHealth> {
    const { owner, repo, anchorLabel } = this.config
    const missing = [
      !owner && { name: 'owner', purpose: 'Org/user dueño del repo' },
      !repo && { name: 'repo', purpose: 'Repo a vigilar' },
      !anchorLabel && {
        name: 'anchorLabel',
        purpose: 'Label que marca qué issues sigue el engine',
      },
    ].filter((f): f is { name: string; purpose: string } => Boolean(f))
    return { ok: missing.length === 0, missing, warnings: [] }
  }
}
