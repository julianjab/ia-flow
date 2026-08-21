import { invalidateMemoized, memoize } from '@ia-flow/shared'
import type {
  BroadcastFn,
  CreateItemInput,
  Disposable,
  IssueItem,
  ProjectSource,
  SourceHealth,
  SourceItem,
  SourceProjectField,
  StatusOption,
  TaskSource,
  UpdateItemInput,
  WatchOptions,
  WebhookMatchHint,
} from '../contract.js'
import { MULTI_SELECT_DATA_TYPE } from '../dispatch/field-ops.js'
import { pollingWatch, webhookWatch } from '../dispatch/watch-helpers.js'
import type { WebhookDelivery } from '../dispatch/webhook-registry.js'
import { markCommentsUsed as markIssueCommentsUsed } from '../github-shared/issue.js'
import { createLogger } from '../logger.js'
import { GitHubIssuesApi, type RestIssue, fromWebhookPayload } from './api/issues-client.js'
import { FieldLabelCodec } from './field-label.js'
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
    private readonly fieldLabels: FieldLabelCodec = new FieldLabelCodec(),
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
        // field:<name>=<value> labels → {name: value}, so `when` conditions
        // and {{task.fields.*}} read a github-issues field the same way
        // they'd read a GitHub Project custom column.
        fields: this.fieldLabels.fieldsFromLabels(issue.labels),
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

  /** Field names (+ observed values) discovered from the repo's `field:*`
   * label catalog — same idea as GitHubProjectSource's synthetic `Labels`
   * field: derived from what's already in use, not a fixed schema, so the
   * UI's condition editor has something to offer without requiring every
   * possible value to be created up front. */
  async getFields(_opts?: { refresh?: boolean }): Promise<SourceProjectField[]> {
    const labels = await this.api.listRepoLabels(this.config.owner, this.config.repo)
    // One fetch feeds both: Status comes from the same StatusLabelCodec
    // getStatuses() uses, custom fields from FieldLabelCodec — no need for
    // getFields() to call getStatuses() separately and hit the API twice.
    //
    // Status is prepended unconditionally (not just when field:* labels
    // exist): before getFields() existed, ProjectSource.getFields being
    // absent made the /source/fields route fall back to a synthetic
    // { name: 'Status', ... } entry so the condition editor always had
    // something to offer. Now that getFields() exists, that fallback never
    // runs — recreate the same guarantee here, or a repo with no field:*
    // labels yet would leave the editor with zero options.
    const statusNames = this.statusLabels.statusesFromCatalog(labels)
    const optionsByField = new Map<string, Set<string>>()
    for (const label of labels) {
      const parsed = this.fieldLabels.parse(label)
      if (!parsed) continue
      const values = optionsByField.get(parsed.name) ?? new Set<string>()
      values.add(parsed.value)
      optionsByField.set(parsed.name, values)
    }
    const custom = [...optionsByField.entries()].map(([name, values]) => ({
      name,
      dataType: 'TEXT',
      options: [...values].sort(),
    }))
    // `Labels` es el campo multi-valor de este source. No estaba en el
    // catálogo: el editor no tenía forma de saber que existía, ni de saber
    // que va con tokens con signo, aunque el runtime ya lo escribiera así.
    // Las opciones son las labels "de usuario": se filtran las que son
    // bookkeeping del propio source (el ancla, los `status:*` y los
    // `field:*`), que ya viajan como Status y como campos propios.
    const userLabels = labels
      .filter((l) => l !== this.config.anchorLabel)
      .filter((l) => !this.statusLabels.isStatusLabel(l))
      .filter((l) => !this.fieldLabels.parse(l))
      .sort()
    return [
      { name: 'Status', dataType: 'SINGLE_SELECT', options: statusNames },
      { name: 'Labels', dataType: MULTI_SELECT_DATA_TYPE, options: userLabels },
      ...custom,
    ]
  }

  async getItems(opts?: { status?: string; refresh?: boolean }): Promise<SourceItem[]> {
    const items = await this.fetchItems({ refresh: opts?.refresh })
    if (!opts?.status) return items
    const wanted = opts.status.toLowerCase()
    return items.filter((i) => i.status.toLowerCase() === wanted)
  }

  /** Direct GraphQL node(id) lookup (GitHubIssuesApi.getById) — not a scan
   * over the cached getItems() list, so this reflects the issue's true
   * current state even if it's no longer anchor-labeled (DivergenceReconciler
   * relies on that: a task in flight must stay reconcilable even if its
   * anchor label got removed mid-run). */
  async getItemById(id: string): Promise<SourceItem | null> {
    const issue = await this.api.getById(id)
    return issue ? this.toSourceItem(issue) : null
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
      fields: (meta.fields as Record<string, string> | undefined) ?? {},
      meta,
    }
  }

  async loadComments(
    item: IssueItem,
  ): Promise<Array<{ id: string; body: string; created_at: string }>> {
    const issueId = item.meta?.issueId as string | undefined
    if (!issueId) return []
    try {
      const raw = await this.api.listComments(issueId)
      return raw.map((c) => ({ id: c.id, body: c.body, created_at: c.created_at }))
    } catch (err) {
      log.warn({ err: (err as Error).message, issueId }, 'loadComments failed — returning empty')
      return []
    }
  }

  async markCommentsUsed(comments: Array<{ id: string; body: string }>): Promise<void> {
    await markIssueCommentsUsed(comments)
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
    return new GitHubIssueTaskSource(
      this.config,
      this.api,
      this.statusLabels,
      this.fieldLabels,
      item,
      broadcast,
    )
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

  /**
   * Push-based watch — replaces the old design where a generic manager
   * decided the fetch strategy. `mode: 'polling'` just arms a steady-state
   * timer (the boot scan is SourceDispatcher's job, not this method's — no
   * immediate tick here, to avoid a duplicate scan on startup).
   * `mode: 'webhook'` registers with webhook-registry and resolves each
   * delivery to a SourceItem straight from its payload when possible (see
   * fromWebhookPayload) — zero GitHub API calls for the common case.
   */
  watch(onItems: (items: SourceItem[]) => void, opts: WatchOptions): Disposable {
    return opts.mode === 'polling'
      ? pollingWatch((o) => this.getItems(o), onItems, opts, log)
      : webhookWatch(onItems, {
          sourceKind: this.kind,
          opts,
          matchesWebhook: (hint) => this.matchesWebhook(hint),
          log,
          logScope: 'GitHub issues',
          resolveDelivery: (delivery) => this.resolveWebhookDelivery(delivery),
        })
  }

  /**
   * Payload-first: an `issues`/`issue_comment` delivery usually carries the
   * full issue already (fromWebhookPayload), so the common case resolves
   * with zero GitHub API calls. Falls back to a single getByNumber when the
   * payload is incomplete, then to a full getItems() scan when there's no
   * delivery at all (manual nudge / fallback timer) or nothing in it
   * resolves to an issue.
   */
  private async resolveWebhookDelivery(delivery?: WebhookDelivery): Promise<SourceItem[]> {
    if (delivery) {
      const direct = fromWebhookPayload(delivery.payload)
      if (direct) return [this.toSourceItem(direct)]

      const rawIssue = delivery.payload.issue as { number?: unknown } | undefined
      const number = typeof rawIssue?.number === 'number' ? rawIssue.number : undefined
      if (number != null) {
        const fetched = await this.api.getByNumber(this.config.owner, this.config.repo, number)
        if (fetched) return [this.toSourceItem(fetched)]
      }
    }
    return this.getItems({ refresh: true })
  }
}
