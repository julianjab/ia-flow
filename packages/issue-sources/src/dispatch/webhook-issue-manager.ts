import type {
  BroadcastFn,
  Disposable,
  IStatusRepository,
  IssueItem,
  PendingTaskRegistryPort,
  ProjectSource,
} from '../contract.js'
import { createLogger } from '../logger.js'
import type { CatchUpOptions } from './catch-up.js'
import { pollIntervalMs } from './polling-issue-manager.js'
import { SourceIssueManager } from './source-issue-manager.js'
import {
  type WebhookHint,
  type WebhookTargetStats,
  registerWebhookTarget,
} from './webhook-registry.js'

const log = createLogger('webhook-issue-manager')

// Read lazily (per instance), never at import time: env vars stored in the DB
// are pushed into process.env by envRepo.loadIntoProcess(), which runs *after*
// this module is imported. A module-level constant would silently ignore
// anything configured from the UI.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

// Bursts are the norm: moving one card on a GitHub Project board emits several
// `projects_v2_item` events within a second. Coalesce them into a single scan.
export const webhookDebounceMs = (): number => envInt('IA_FLOW_WEBHOOK_DEBOUNCE_MS', 1_500)
// Optional safety net for dropped deliveries. **Off by default**: webhook mode
// means push only — no periodic pull, no matter how slow. Set
// IA_FLOW_WEBHOOK_FALLBACK_MS to a positive number to opt into a periodic scan
// (e.g. while a hook is misconfigured); anything else keeps the loop silent.
export const webhookFallbackMs = (): number => envInt('IA_FLOW_WEBHOOK_FALLBACK_MS', 0)

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
    statusRepo: IStatusRepository,
    pendingTasks: PendingTaskRegistryPort,
    debounceMs: number = webhookDebounceMs(),
    fallbackMs: number = webhookFallbackMs(),
    opts: CatchUpOptions = {},
  ) {
    super(projectId, source, broadcast, statusRepo, pendingTasks)
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
    if (!reason.startsWith('fallback') && !this.deliveryReceived) {
      this.deliveryReceived = true
      log.info({ projectId: this.projectId, reason }, 'First webhook delivery received')
    }
    this.lastEventAt = new Date().toISOString()
    this.lastReason = reason
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
      log.debug({ projectId: this.projectId, reason }, 'Webhook scan cycle')
      await this.runCycle(this.dispatchFn ?? (async () => {}), { refresh: true })
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
