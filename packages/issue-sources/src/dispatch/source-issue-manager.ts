import type {
  BroadcastFn,
  IssueItem,
  PendingTaskRegistryPort,
  ProjectSource,
  SourceHealth,
  SourceItem,
  TaskSource,
} from '../contract.js'
import { getRateLimit } from '../github-shared/rate-limit.js'
import { createLogger } from '../logger.js'
import { type Disposable, IssueManager } from './issue-manager.js'
import { isProjectPaused } from './polling-pause.js'

const log = createLogger('source-issue-manager')

// Health probes hit the source (usually GitHub API); cache briefly so the
// per-cycle gate + per-dispatch safety net don't call it back-to-back.
const HEALTH_TTL_MS = 60_000

// Cap on concurrent in-flight dispatches per project per cycle (see the
// concurrency-cap comment in runCycle). Configurable via
// IA_FLOW_MAX_CONCURRENT_DISPATCHES for deploys that need a tighter or
// looser budget. Read lazily, never at import time — same reasoning as
// pollIntervalMs()/webhookDebounceMs(): env vars loaded into the DB reach
// process.env only after this module is imported.
function maxConcurrentDispatches(): number {
  const raw = process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : 5
}

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
//   · Fetch source.getItems() once and dispatch everything not already
//     working — whether an item actually triggers an agent is entirely
//     TaskDispatcher's call (project/repo/status/when via selectAgent, see
//     packages/agent-engine/src/agent-selection.ts). This manager does not
//     pre-filter by status: an agent-engine concern doesn't belong in the
//     issue-sources scan loop. For an agent with a `statusName`, an
//     unrelated status is a cheap no-op dispatch (selectAgent rejects
//     before getBlockers/loadComments/runAgent). For an agent with NO
//     `statusName` (matches every status by design — see matchesStatus in
//     agent-selection.ts) there's no such cap: it becomes a candidate for
//     EVERY item the source returns, closed/archived columns included,
//     since nothing here bounds "every status" to the ones ia-flow actually
//     tracks anymore. That's intentional (see TaskDispatcher's own doc) —
//     scoping a status-less agent, if it shouldn't run against the whole
//     board, is the operator's job via `when` or an explicit `statusName`,
//     not this manager's.
//   · Reconcile in-flight agents whose task drifted to another status.
//
// TaskSources are delegated to the source — see ProjectSource.
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
    protected readonly pendingTasks: PendingTaskRegistryPort,
    // Cheap pre-fetch gate: skip the cycle (no getHealth, no getItems — the
    // GraphQL calls that actually cost quota) when the project has no agent
    // wired at all yet. Unlike the old statuses-prefilter this removed, a
    // boolean has no "matches every status" representation problem — a
    // project with only a global (statusName-less) agent still reports
    // `true` here since that agent is visible to every project. Defaults to
    // always-scan so existing callers/tests don't need to pass it.
    protected readonly hasWiredAgents: () => boolean = () => true,
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
    opts: { refresh?: boolean; reason?: string } = {},
  ): Promise<void> {
    // caller/reason identify who invoked this cycle (WebhookIssueManager.scan
    // vs PollingIssueManager's timer, and *why* — 'startup', a webhook
    // delivery reason, 'concurrency-cap-retry', 'fallback', 'interval') so
    // the concurrency-cap and error logs below can show it without the
    // reader having to cross-reference PIDs/timestamps against this file.
    const caller = this.constructor.name
    const reason = opts.reason ?? 'unknown'
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
      // Nothing to scan — the project has no agent wired AND nothing of
      // this project's is in flight to reconcile. Checked before
      // getHealth/getItems (the calls that actually spend GraphQL quota):
      // without this, a brand-new or agent-less project would fetch the
      // full board every poll tick / webhook delivery for zero possible
      // outcome, which is exactly the rate-limit failure mode the comments
      // in this file already warn about elsewhere. The pending-tasks check
      // matters: an operator disabling/deleting the last agent for a
      // project with a run still in flight must not orphan that run from
      // divergence reconciliation below — same project-match rule as that
      // loop (`projectId` unset counts as "could be mine").
      const hasRelevantPending = () =>
        [...this.pendingTasks.listPendingTasks()].some(
          ([, pending]) => !pending.task.projectId || pending.task.projectId === this.projectId,
        )
      if (!this.hasWiredAgents() && !hasRelevantPending()) return

      const health = await this.getHealth()
      if (!health.ok) return // getHealth already logged the state change

      // Track current status per item so the divergence check below can
      // reconcile pending agents against the source's latest view (user may
      // have moved a card out of the status where the agent was dispatched).
      const currentStatusById = new Map<string, string>()

      // Single fetch per cycle — a per-status loop would bypass the source's
      // items cache and issue one full GraphQL project fetch per status,
      // which is what pushed the user's account over GitHub's GraphQL rate
      // limit in the first place. No status prefilter here anymore either
      // (see class doc, and the caveat there about status-less agents) —
      // every item goes through `dispatch`.
      const allItems = await this.source.getItems(opts.refresh ? { refresh: true } : undefined)
      const cap = maxConcurrentDispatches()
      let skippedForConcurrency = 0
      for (const raw of allItems) {
        const item = this.toIssueItem(raw)
        item.projectId = this.projectId
        // Always recorded, even if dispatch itself gets capped below —
        // reconciliation needs every item's live status regardless of
        // whether this cycle got around to dispatching it.
        currentStatusById.set(item.id, item.status)
        if (item.agentWorking) continue
        // Already handed off to dispatch in a previous cycle, or the
        // orchestrator has already registered a pending task for it —
        // either way, skip so we don't start a second session.
        if (this.dispatching.has(item.id) || this.pendingTasks.getPendingTask(item.id)) continue
        // Concurrency cap: without a status prefilter bounding the fetched
        // set anymore, a broadly-scoped agent (no statusName, or a lax
        // `when`) can match every item on the board — dispatching all of
        // them at once would fire that many concurrent runAgent calls
        // (AgentOrchestrator locks per-task, not globally) in one tick.
        // Items skipped here aren't lost: they're not marked `dispatching`,
        // so a later cycle picks them up — this just spreads a large batch
        // across cycles instead of firing it all at once. Polling mode gets
        // that "later cycle" for free from its own timer; push-only webhook
        // mode does not, so it arms itself via onDispatchDeferred — called
        // HERE, synchronously, in the same tick as the skip. That timing
        // matters: an item this loop dispatches just above can resolve fast
        // enough (e.g. TaskDispatcher rejects it outright, no `await` of its
        // own worth mentioning) that its `.finally() → onDispatchSlotFreed()`
        // races the "did anything get deferred" signal — if that signal were
        // set only after this whole loop/cycle finishes (as an earlier
        // version of this code did), the free event could fire first, see
        // nothing armed yet, and the deferred items would never get retried
        // until an unrelated delivery landed. Arming inline here closes that
        // window: it's set before any dispatch from this same loop can
        // possibly resolve.
        if (this.dispatching.size >= cap) {
          skippedForConcurrency++
          this.onDispatchDeferred()
          continue
        }
        this.dispatching.add(item.id)
        dispatch(item)
          .catch((err) =>
            log.error({ err, id: item.id, projectId: this.projectId }, 'Dispatch error'),
          )
          .finally(() => {
            this.dispatching.delete(item.id)
            this.onDispatchSlotFreed()
          })
      }
      if (skippedForConcurrency > 0) {
        log.info(
          {
            projectId: this.projectId,
            skipped: skippedForConcurrency,
            cap,
            caller,
            method: 'runCycle',
            reason,
          },
          'Concurrency cap reached — deferred some dispatches to the next cycle',
        )
      }

      // Manual gate: cancel any in-flight agent whose task has drifted from
      // its initial status (user dragged the card in the board, or an
      // external write moved it). Runs after dispatch so we don't cancel a
      // task we just re-picked up in the same cycle.
      //
      // Now that every returned item is scanned (no status prefilter), this
      // loop can see statuses that used to be invisible to it — so it's
      // worth spelling out why an agent's OWN status transitions can't
      // trigger a self-cancel here. Two mechanisms, both landing in
      // `pending.reconciliationStatus` (NOT `initialStatus`, which stays
      // frozen for complete_task/fail_task's own statusChangedByPrompt
      // check — see the field docs in pending-tasks.ts):
      //   1. AgentOutcomesSchema.onProcess — Agent.ts applies it and
      //      captures the result into both `initialStatus` and
      //      `reconciliationStatus` (via registerPendingTask) BEFORE the
      //      provider ever starts, and `dispatch()` above is fire-and-forget
      //      with no `await` before this loop runs — so a task dispatched
      //      THIS cycle can't appear in `listPendingTasks()` until the NEXT
      //      cycle, by which point `source.getItems()` reflects the
      //      post-onProcess status (modulo a stale items-cache — see below).
      //   2. `set_task_field` mid-run (e.g. lh116-ci-watcher forcing Status
      //      as an onError fallback) — resyncs `reconciliationStatus`
      //      directly, immediately, from inside the tool handler.
      // Both rely on `source.getItems()` returning a fresh-enough view: in
      // polling mode (no `refresh`) a source-side items-cache TTL longer
      // than the poll interval could still return a stale pre-move value
      // and trip a false-positive self-cancel — a preexisting interaction
      // with item caching, not introduced by this change.
      for (const [taskId, pending] of this.pendingTasks.listPendingTasks()) {
        if (pending.task.projectId && pending.task.projectId !== this.projectId) continue
        const currentStatus = currentStatusById.get(taskId)
        // Every item the source returns is now scanned (no status
        // prefilter), so not seeing this task id at all means the source
        // itself didn't return it this cycle (closed, deleted, transient
        // fetch gap) — safer to leave it alone than cancel on an absence.
        if (!currentStatus) continue
        const baseline = pending.reconciliationStatus ?? pending.initialStatus
        if (currentStatus.toLowerCase() === baseline.toLowerCase()) continue
        log.info(
          { taskId, from: baseline, to: currentStatus },
          'Task moved during agent run — cancelling',
        )
        try {
          await pending.cancel?.()
        } catch (err) {
          log.warn({ taskId, err }, 'cancel handler threw — removing anyway')
        }
        this.pendingTasks.removePendingTask(taskId)
      }
    } catch (err) {
      log.error(
        { err, projectId: this.projectId, caller, method: 'runCycle', reason },
        'Scan error — will retry next cycle',
      )
    }
  }

  /**
   * Called synchronously, inline, the moment an item gets deferred past the
   * concurrency cap — i.e. right where `skippedForConcurrency++` happens,
   * NOT after the cycle finishes (see the comment at that call site for why
   * the timing matters: a same-cycle dispatch can free its slot, and race
   * onDispatchDeferred, before the cycle-level bookkeeping would otherwise
   * get a chance to run). No-op by default. WebhookIssueManager overrides
   * this to arm its retry-on-next-free-slot flag.
   */
  protected onDispatchDeferred(): void {}

  /**
   * Called every time a dispatched item finishes (success or error) and its
   * slot in `dispatching` frees up. No-op by default (polling mode's own
   * timer is all it needs). WebhookIssueManager overrides this to retry a
   * cycle that deferred items past the concurrency cap — event-driven, not
   * a timer: no backoff to tune, no risk of polling GraphQL while a long
   * agent run is still using its slot.
   */
  protected onDispatchSlotFreed(): void {}

  /** Crash recovery (e.g. reset stuck working flags). Non-fatal on failure. */
  protected async onDaemonStart(): Promise<void> {
    try {
      await this.source.onDaemonStart?.()
    } catch (err) {
      log.error({ err, projectId: this.projectId }, 'onDaemonStart failed')
    }
  }

  getTransitionManager(item: IssueItem): TaskSource {
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

  protected toIssueItem(raw: SourceItem): IssueItem {
    if (this.source.toIssueItem) return this.source.toIssueItem(raw)
    // Fallback (default mapping) — matches contract.defaultToIssueItem but
    // importing that here would cause a cycle in the future if we add more
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
