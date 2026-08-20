import type {
  BroadcastFn,
  Disposable,
  IssueItem,
  PendingTaskRegistryPort,
  ProjectSource,
} from '../contract.js'
import { createLogger } from '../logger.js'
import type { CatchUpOptions } from './catch-up.js'
import {
  CONCURRENCY_RETRY_FLOOR_MS,
  concurrencyRetryMaxMs,
  webhookDebounceMs,
  webhookFallbackMs,
} from './env.js'
import type { ProjectFilter } from './project-filter.js'
import { SourceIssueManager } from './source-issue-manager.js'
import {
  type WebhookHint,
  type WebhookTargetStats,
  registerWebhookTarget,
} from './webhook-registry.js'

const log = createLogger('webhook-issue-manager')

// Re-exported for back-compat — moved to env.js so github-issues/source.ts's
// watch() can default to the same values without importing this class
// (which SourceDispatcher is replacing).
export { webhookDebounceMs, webhookFallbackMs, concurrencyRetryMaxMs, CONCURRENCY_RETRY_FLOOR_MS }
// Internal trigger reason for the concurrency-cap retry (see
// onDispatchSlotFreed below) — excluded from delivery bookkeeping in
// `trigger()` the same way 'fallback' is, so a self-inflicted retry never
// flips `deliveryReceived`/`lastEventAt`/`lastReason`, which exist
// specifically to show whether the PROVIDER has ever reached this project.
const CONCURRENCY_RETRY_REASON = 'concurrency-cap-retry'

// Push mode: scan when the provider says something changed.
//
// Cycle logic is inherited from SourceIssueManager; this class owns *when*:
//   · once at startup, to catch up on what moved while the daemon was down
//     (opt out with IA_FLOW_STARTUP_SCAN=0 — see catch-up.ts),
//   · on every matching webhook delivery (debounced + coalesced),
//   · never on a timer unless IA_FLOW_WEBHOOK_FALLBACK_MS says otherwise.
//
// Scans triggered by an event always bypass the source's items cache — the
// event *is* the signal that the data changed, so a cached view would defeat
// the point.
export class WebhookIssueManager extends SourceIssueManager {
  private dispatchFn: ((item: IssueItem) => Promise<void>) | null = null
  private stopped = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private scanning = false
  // Set when a delivery lands mid-scan: the running cycle may have fetched
  // before that change was visible, so schedule exactly one more pass.
  private rescanQueued = false
  // True while the last cycle deferred items past the concurrency cap and
  // nothing has retried since — cleared by onDispatchSlotFreed the moment a
  // dispatch actually frees a slot, which is what triggers the retry. Not a
  // timer: no backoff to tune, no risk of polling while a long agent run
  // still holds its slot (see onDispatchSlotFreed below).
  private waitingForDispatchSlot = false
  // Guards CONCURRENCY_RETRY_FLOOR_MS — only one retry timer in flight.
  private concurrencyRetryTimer: ReturnType<typeof setTimeout> | null = null
  // How many concurrency-cap retries have fired back-to-back with no real
  // progress — feeds the exponential backoff in onDispatchSlotFreed. Reset to
  // 0 by any non-retry trigger() (a real webhook, startup, fallback — see
  // trigger()) and by a retry cycle whose skippedForConcurrency comes back
  // lower than the previous one (see scan()). Left at its current value by
  // an unmeasured cycle (skippedForConcurrency: null) — an early-exit cycle
  // (paused, rate-limited, unhealthy) says nothing about whether the backlog
  // is draining, so it must not affect the backoff either way.
  private consecutiveCapRetries = 0
  // skippedForConcurrency from the last cycle that actually measured it
  // (i.e. wasn't null) — compared against the next such cycle to tell
  // "still stuck behind the same backlog" from "draining, needs another
  // pass". Starts at Infinity so the very first retry cycle can never look
  // like a regression (anything is "progress" against no prior baseline).
  private lastSkippedForConcurrency = Number.POSITIVE_INFINITY
  private lastEventAt: string | null = null
  private lastReason: string | null = null
  private lastScanAt: string | null = null
  // Reported in stats so the UI can say whether the provider has ever reached
  // us. Purely informational — it no longer changes any cadence.
  private deliveryReceived = false
  private readonly debounceMs: number
  private readonly fallbackMs: number
  private readonly crashRecovery: boolean
  private readonly initialScan: boolean

  constructor(
    projectId: string,
    source: ProjectSource,
    broadcast: BroadcastFn,
    pendingTasks: PendingTaskRegistryPort,
    debounceMs: number = webhookDebounceMs(),
    fallbackMs: number = webhookFallbackMs(),
    opts: CatchUpOptions = {},
    hasWiredAgents?: () => boolean,
    filter?: ProjectFilter,
  ) {
    super(projectId, source, broadcast, pendingTasks, hasWiredAgents, filter)
    this.debounceMs = debounceMs
    this.fallbackMs = fallbackMs
    this.crashRecovery = opts.crashRecovery ?? true
    this.initialScan = opts.initialScan ?? true
  }

  start(dispatch: (item: IssueItem) => Promise<void>): Disposable {
    this.dispatchFn = dispatch
    const unregister = registerWebhookTarget({
      projectId: this.projectId,
      matches: (hint) => this.matches(hint),
      trigger: (reason) => this.trigger(reason),
      stats: () => this.stats(),
    })

    // Independent flags: recovery may run without a scan (IA_FLOW_STARTUP_SCAN=0
    // still has to unstick dead runs) and a scan without recovery (a new manager
    // on reload). See catch-up.ts.
    if (this.crashRecovery) {
      void this.onDaemonStart().then(() => {
        if (this.initialScan) void this.scan('startup')
      })
    } else if (this.initialScan) {
      void this.scan('startup')
    }

    // No timer unless the operator explicitly asked for a safety net. Webhook
    // mode is push-only: nothing here pulls on a schedule.
    const timer =
      this.fallbackMs > 0 ? setInterval(() => this.trigger('fallback'), this.fallbackMs) : null

    log.info(
      {
        projectId: this.projectId,
        debounceMs: this.debounceMs,
        fallbackMs: this.fallbackMs || 'off',
        crashRecovery: this.crashRecovery,
        initialScan: this.initialScan,
      },
      'Webhook mode started',
    )

    return {
      dispose: () => {
        this.stopped = true
        unregister()
        if (timer) clearInterval(timer)
        if (this.debounceTimer) clearTimeout(this.debounceTimer)
        this.debounceTimer = null
        if (this.concurrencyRetryTimer) clearTimeout(this.concurrencyRetryTimer)
        this.concurrencyRetryTimer = null
      },
    }
  }

  /**
   * Does this delivery concern my project? Delegated to the source when it can
   * answer; sources that can't (no `matchesWebhook`) match everything, which
   * degrades to "scan on any delivery" — correct, just chattier.
   */
  async matches(hint: WebhookHint): Promise<boolean> {
    if (!this.source.matchesWebhook) return true
    return this.source.matchesWebhook(hint)
  }

  /** Queue a scan. Debounced so an event burst produces a single cycle. */
  trigger(reason: string): void {
    if (this.stopped) return
    log.debug(
      { projectId: this.projectId, caller: 'WebhookIssueManager', method: 'trigger', reason },
      'Scan triggered',
    )
    // Any trigger that isn't our own concurrency-cap retry is a fresh signal
    // (a real webhook, startup, or the fallback timer) — reset the backoff so
    // it always reacts fast, even right after a run of retries had backed
    // off against a backlog that looked stuck.
    if (reason !== CONCURRENCY_RETRY_REASON) {
      this.consecutiveCapRetries = 0
    }
    // 'fallback' (the optional safety-net timer) and the internal
    // concurrency-cap retry are both self-inflicted, not a provider
    // delivery — excluded from delivery bookkeeping so a quiet project that
    // never received a real webhook doesn't get misreported as having one.
    const isSelfInflicted = reason.startsWith('fallback') || reason === CONCURRENCY_RETRY_REASON
    if (!isSelfInflicted && !this.deliveryReceived) {
      this.deliveryReceived = true
      log.info({ projectId: this.projectId, reason }, 'First webhook delivery received')
    }
    if (!isSelfInflicted) {
      this.lastEventAt = new Date().toISOString()
      this.lastReason = reason
    }
    if (this.debounceMs <= 0) {
      void this.scan(reason)
      return
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.scan(reason)
    }, this.debounceMs)
  }

  /**
   * Arms the retry — called synchronously by SourceIssueManager the instant
   * an item gets deferred past the concurrency cap, inline in the dispatch
   * loop (see the comment at that call site). Must happen there, not after
   * `runCycle` returns: a same-cycle dispatch can resolve and free its slot
   * (racing onDispatchSlotFreed below) before cycle-level bookkeeping would
   * otherwise get a chance to run, which would silently drop the retry —
   * confirmed by hitting exactly that race before moving this here.
   */
  protected onDispatchDeferred(): void {
    this.waitingForDispatchSlot = true
    log.debug(
      { projectId: this.projectId, caller: 'WebhookIssueManager', method: 'onDispatchDeferred' },
      'Concurrency retry armed — a dispatch was deferred past the cap',
    )
  }

  /**
   * Event-driven concurrency-cap retry: fires when a dispatch finishes and
   * frees a slot in `dispatching`, but only when something is actually
   * waiting on it (`waitingForDispatchSlot`, armed by onDispatchDeferred
   * above) — so a quiet project with no backlog never triggers an extra
   * scan just because something unrelated finished. Debounced by
   * CONCURRENCY_RETRY_FLOOR_MS (see its doc) rather than firing immediately
   * — that's what keeps it from tight-looping when slots free almost
   * instantly, not the freeing event itself, which by design can happen
   * very fast.
   */
  protected onDispatchSlotFreed(): void {
    if (!this.waitingForDispatchSlot || this.concurrencyRetryTimer) return
    this.waitingForDispatchSlot = false
    // Exponential backoff off CONCURRENCY_RETRY_FLOOR_MS, capped at
    // concurrencyRetryMaxMs(). consecutiveCapRetries only grows here and only
    // resets on a real trigger() or on measured progress (see trigger()/
    // scan()) — a backlog that keeps re-hitting the cap backs off instead of
    // retrying every second forever (the GraphQL-quota-exhaustion failure
    // mode this whole mechanism exists to avoid).
    const delayMs = Math.min(
      CONCURRENCY_RETRY_FLOOR_MS * 2 ** this.consecutiveCapRetries,
      concurrencyRetryMaxMs(),
    )
    this.consecutiveCapRetries++
    log.debug(
      {
        projectId: this.projectId,
        caller: 'WebhookIssueManager',
        method: 'onDispatchSlotFreed',
        delayMs,
        consecutiveCapRetries: this.consecutiveCapRetries,
      },
      'Scheduling concurrency-cap retry scan',
    )
    this.concurrencyRetryTimer = setTimeout(() => {
      this.concurrencyRetryTimer = null
      log.debug(
        { projectId: this.projectId, caller: 'WebhookIssueManager', method: 'onDispatchSlotFreed' },
        'Concurrency-cap retry timer fired — re-triggering scan',
      )
      this.trigger(CONCURRENCY_RETRY_REASON)
    }, delayMs)
  }

  private async scan(reason: string): Promise<void> {
    if (this.stopped) return
    if (this.scanning) {
      // A cycle is already in flight and may have fetched before this change
      // landed — remember to run once more when it finishes.
      this.rescanQueued = true
      return
    }
    this.scanning = true
    try {
      log.debug(
        { projectId: this.projectId, caller: 'WebhookIssueManager', method: 'scan', reason },
        'Webhook scan cycle',
      )
      // Arming the concurrency-cap retry (waitingForDispatchSlot) happens
      // inline, synchronously, inside this call via onDispatchDeferred — not
      // off the return value here, which would race a fast dispatch's
      // onDispatchSlotFreed (see both methods' docs).
      const { skippedForConcurrency } = await this.runCycle(this.dispatchFn ?? (async () => {}), {
        refresh: true,
        reason,
      })
      // A retry cycle that skips fewer items than the last measured one is
      // real progress — the backlog is draining, even if it's still capped —
      // so the backoff resets and the next retry stays fast. `null` (an
      // early-exit cycle that never touched the backlog) is left alone: see
      // consecutiveCapRetries' doc for why.
      if (skippedForConcurrency !== null) {
        if (skippedForConcurrency < this.lastSkippedForConcurrency) {
          this.consecutiveCapRetries = 0
        }
        this.lastSkippedForConcurrency = skippedForConcurrency
      }
      this.lastScanAt = new Date().toISOString()
    } finally {
      this.scanning = false
    }
    if (this.rescanQueued && !this.stopped) {
      this.rescanQueued = false
      await this.scan(`${reason}+coalesced`)
    }
  }

  stats(): WebhookTargetStats {
    return {
      projectId: this.projectId,
      sourceKind: this.source.kind,
      lastEventAt: this.lastEventAt,
      lastReason: this.lastReason,
      lastScanAt: this.lastScanAt,
      scanning: this.scanning,
      fallbackIntervalMs: this.fallbackMs,
      deliveryReceived: this.deliveryReceived,
    }
  }
}
