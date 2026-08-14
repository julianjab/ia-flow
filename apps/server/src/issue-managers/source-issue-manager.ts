import { getRateLimit } from '../adapters/github/api/rate-limit.js'
import { getPendingTask, listPendingTasks, removePendingTask } from '../agents/pending-tasks.js'
import type { IStatusRepository } from '../domain/ports/IStatusRepository.js'
import { createLogger } from '../logger.js'
import type { ProjectSource, SourceHealth } from '../project-sources/types.js'
import { type Disposable, IssueManager } from './issue-manager.js'
import { isProjectPaused } from './polling-pause.js'
import type { TransitionManager } from './transition-manager.js'
import type { BroadcastFn, IssueItem } from './types.js'

const log = createLogger('source-issue-manager')

// Health probes hit the source (usually GitHub API); cache briefly so the
// per-cycle gate + per-dispatch safety net don't call it back-to-back.
const HEALTH_TTL_MS = 60_000

// Generic manager over a ProjectSource. Knows nothing about GitHub/Linear/Jira
// — the entire provider concern is behind the injected ProjectSource. Adding a
// new provider = ship a ProjectSource impl; no manager subclass, no factory.
//
// This base owns *what* a scan cycle does. Subclasses own *when* it runs:
//   · PollingIssueManager — setInterval (pull mode).
//   · WebhookIssueManager — provider push events (+ slow safety net).
//
// Cycle responsibilities:
//   · Skip when the project is paused or the GitHub rate window is exhausted.
//   · Skip when source.getHealth() reports a broken config (missing required
//     fields). Logs once per state transition so the log doesn't spam.
//   · Fetch source.getItems() once, filter by the statuses the project has
//     configured with agents, and dispatch what isn't already working.
//   · Reconcile in-flight agents whose task drifted to another status.
//
// TransitionManagers are delegated to the source — see ProjectSource.
export abstract class SourceIssueManager extends IssueManager {
  private healthCache: { at: number; health: SourceHealth } | null = null
  private lastHealthOk: boolean | null = null
  // Log the GitHub rate-limit skip only on state transitions so a multi-hour
  // cooldown doesn't spam the log on every cycle.
  private lastRateLimitedLog = false
  // In-memory guard against double-dispatch. `agentWorking` (backed by the
  // GitHub Project "Working" field) is our primary skip signal, but it has
  // two blind spots that let a cycle spawn a second tmux/iTerm session for
  // the same task:
  //   1. The project has no "Working" field — setAgentWorking() silently
  //      no-ops, so the flag never flips and every cycle re-dispatches.
  //   2. The GraphQL mutation is still in flight when the next cycle fires;
  //      refresh:true fetches see the pre-mutation value.
  // Skip any id we've already handed to `dispatch` until it resolves.
  private readonly dispatching = new Set<string>()

  constructor(
    protected readonly projectId: string,
    protected readonly source: ProjectSource,
    protected readonly broadcast: BroadcastFn,
    protected readonly statusRepo: IStatusRepository,
  ) {
    super()
  }

  abstract start(dispatch: (item: IssueItem) => Promise<void>): Disposable

  async getHealth(): Promise<SourceHealth> {
    if (!this.source.getHealth) return { ok: true, missing: [], warnings: [] }
    if (this.healthCache && Date.now() - this.healthCache.at < HEALTH_TTL_MS) {
      return this.healthCache.health
    }
    const health = await this.source.getHealth()
    this.healthCache = { at: Date.now(), health }
    // Log only on ok↔fail transitions so a broken project isn't spammed every
    // cycle, but the operator still sees it flip.
    if (this.lastHealthOk !== health.ok) {
      if (!health.ok) {
        log.warn(
          {
            projectId: this.projectId,
            missing: health.missing.map((f) => f.name),
            message: health.message,
          },
          'Source unhealthy — scans paused',
        )
      } else {
        log.info({ projectId: this.projectId }, 'Source healthy again — resuming scans')
      }
      this.lastHealthOk = health.ok
    }
    return health
  }

  /**
   * One scan cycle: fetch → dispatch → reconcile. Never throws; every failure
   * is logged and the next cycle retries.
   *
   * @param refresh bypass the source's items cache. Webhook mode passes true
   *   (the event *is* the signal that data changed and GitHub's 60s items TTL
   *   would otherwise serve a stale view); polling leaves it false so
   *   consecutive ticks are absorbed by the cache.
   */
  protected async runCycle(
    dispatch: (item: IssueItem) => Promise<void>,
    opts: { refresh?: boolean } = {},
  ): Promise<void> {
    // In-memory operator pause — skips the cycle wholesale (no source calls,
    // no dispatch, no divergence reconciliation). In-flight agents keep
    // running; only the loop is silenced.
    if (isProjectPaused(this.projectId)) return
    // GitHub-wide cooldown: if the token's rate window is exhausted, skip the
    // cycle entirely. Every source call would otherwise fail fast against
    // `guardBeforeCall` and only add log noise.
    const rl = getRateLimit()
    if (rl.limited) {
      if (!this.lastRateLimitedLog) {
        log.warn(
          { projectId: this.projectId, resource: rl.resource, resetAt: rl.resetAt },
          'GitHub rate limit exhausted — skipping scan cycles until reset',
        )
        this.lastRateLimitedLog = true
      }
      return
    }
    if (this.lastRateLimitedLog) {
      log.info({ projectId: this.projectId }, 'GitHub rate limit recovered — resuming scans')
      this.lastRateLimitedLog = false
    }

    try {
      const health = await this.getHealth()
      if (!health.ok) return // getHealth already logged the state change

      const statuses = this.statusRepo.list(this.projectId).map((s) => s.name)
      if (!statuses.length) {
        // Nothing to scan — the project has no wired agents yet.
        return
      }
      // Track current status per item across all scanned statuses so the
      // divergence check below can reconcile pending agents against the
      // source's latest view (user may have moved a card out of the status
      // where the agent was dispatched).
      const currentStatusById = new Map<string, string>()

      // Single fetch per cycle — a per-status loop would bypass the source's
      // items cache and issue one full GraphQL project fetch per configured
      // status, which is what pushed the user's account over GitHub's GraphQL
      // rate limit. Fetch once, filter in memory.
      const allItems = await this.source.getItems(opts.refresh ? { refresh: true } : undefined)
      const statusSet = new Set(statuses.map((s) => s.toLowerCase()))
      for (const raw of allItems) {
        if (!statusSet.has(raw.status.toLowerCase())) continue
        const item = this.toIssueItem(raw)
        item.projectId = this.projectId
        currentStatusById.set(item.id, item.status)
        if (item.agentWorking) continue
        // Already handed off to dispatch in a previous cycle, or the
        // orchestrator has already registered a pending task for it —
        // either way, skip so we don't start a second session.
        if (this.dispatching.has(item.id) || getPendingTask(item.id)) continue
        this.dispatching.add(item.id)
        dispatch(item)
          .catch((err) =>
            log.error({ err, id: item.id, projectId: this.projectId }, 'Dispatch error'),
          )
          .finally(() => this.dispatching.delete(item.id))
      }

      // Manual gate: cancel any in-flight agent whose task has drifted from
      // its initial status (user dragged the card in the board, or an
      // external write moved it). Runs after dispatch so we don't cancel a
      // task we just re-picked up in the same cycle.
      for (const [taskId, pending] of listPendingTasks()) {
        if (pending.task.projectId && pending.task.projectId !== this.projectId) continue
        const currentStatus = currentStatusById.get(taskId)
        // If we didn't see the item at all this cycle it might live in a
        // status we don't scan (no agents wired) — safer to leave it alone.
        if (!currentStatus) continue
        if (currentStatus.toLowerCase() === pending.initialStatus.toLowerCase()) continue
        log.info(
          { taskId, from: pending.initialStatus, to: currentStatus },
          'Task moved during agent run — cancelling',
        )
        try {
          await pending.cancel?.()
        } catch (err) {
          log.warn({ taskId, err }, 'cancel handler threw — removing anyway')
        }
        removePendingTask(taskId)
      }
    } catch (err) {
      log.error({ err, projectId: this.projectId }, 'Scan error — will retry next cycle')
    }
  }

  /** Crash recovery (e.g. reset stuck working flags). Non-fatal on failure. */
  protected async onDaemonStart(): Promise<void> {
    try {
      await this.source.onDaemonStart?.()
    } catch (err) {
      log.error({ err, projectId: this.projectId }, 'onDaemonStart failed')
    }
  }

  getTransitionManager(item: IssueItem): TransitionManager {
    if (!this.source.getTransitionManager) {
      throw new Error(
        `Source '${this.source.kind}' does not implement getTransitionManager — cannot drive transitions`,
      )
    }
    return this.source.getTransitionManager(item, this.broadcast)
  }

  async getBlockers(
    item: IssueItem,
  ): Promise<Array<{ id: string; ref?: string; title?: string; status?: string; url?: string }>> {
    if (!this.source.getBlockers) return []
    return this.source.getBlockers(item)
  }

  async loadComments(item: IssueItem): Promise<Array<{ body: string; created_at: string }>> {
    if (!this.source.loadComments) return []
    return this.source.loadComments(item)
  }

  protected toIssueItem(raw: import('../project-sources/types.js').SourceItem): IssueItem {
    if (this.source.toIssueItem) return this.source.toIssueItem(raw)
    // Fallback (default mapping) — matches project-sources/types.defaultToIssueItem
    // but importing that here would cause a cycle in the future if we add more
    // helpers; the shape is small enough to duplicate.
    //
    // Repo resolution order: custom "Repos" field (multi/refined) → built-in
    // Repository (single, source-native). Sources that host issues in their
    // final repo (e.g. la-haus/lh-seller-v2-frontend) don't need to fill the
    // custom Repos field; the built-in Repository already tells us where the
    // work lives. Inbox flows still work: pre-refinement the issue lives in
    // the inbox repo, so `repos = [inbox]`; the refiner then narrows it via
    // `set_task_field` or moves the issue.
    const fromCustomField = raw.repos
      ? raw.repos
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : []
    const hostRepo = raw.meta?.repoName as string | undefined
    const repos = fromCustomField.length > 0 ? fromCustomField : hostRepo ? [hostRepo] : []
    return {
      id: raw.id,
      title: raw.title,
      description: '',
      type: ((raw.meta?.type as string) ?? '').toLowerCase(),
      repos,
      status: raw.status,
      agentWorking: raw.meta?.working === true,
      issueNumber: raw.meta?.issueNumber as number | undefined,
      issueUrl: raw.meta?.issueUrl as string | undefined,
      labels: (raw.meta?.labels as string[] | undefined) ?? [],
      assignees: (raw.meta?.assignees as string[] | undefined) ?? [],
      fields: (raw.meta?.fields as Record<string, string> | undefined) ?? {},
      meta: raw.meta,
    }
  }
}
