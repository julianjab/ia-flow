import type { IStatusRepository } from '../domain/ports/IStatusRepository.js'
import { createLogger } from '../logger.js'
import type { ProjectSource } from '../project-sources/types.js'
import type { Disposable } from './issue-manager.js'
import { pollIntervalMs } from './polling-issue-manager.js'
import { SourceIssueManager } from './source-issue-manager.js'
import type { BroadcastFn, IssueItem } from './types.js'
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
// Safety net for dropped/misconfigured deliveries — a slow pull so a project
// can't stall forever if the webhook never arrives. 0 disables it entirely.
export const webhookFallbackMs = (): number => envInt('IA_FLOW_WEBHOOK_FALLBACK_MS', 15 * 60_000)

// Push mode: scan when the provider says something changed.
//
// Cycle logic is inherited from SourceIssueManager; this class owns *when*:
//   · once at startup (catch up on whatever happened while we were down),
//   · on every matching webhook delivery (debounced + coalesced),
//   · on a fallback interval so a dropped delivery isn't fatal.
//
// The fallback is adaptive, because webhook is the default mode and a project
// whose hook was never configured would otherwise degrade from a 30s poll to a
// 15min one without anyone noticing: until the first delivery arrives we fall
// back at the *polling* interval (same responsiveness as pull mode), and only
// relax to the slow interval once the provider has proven it can reach us.
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
  private lastScanStartedMs = 0
  // Flips on the first real delivery. Until then the fallback runs at the
  // polling cadence — see the adaptive-fallback note above.
  private deliveryReceived = false
  private readonly debounceMs: number
  private readonly fallbackMs: number

  constructor(
    projectId: string,
    source: ProjectSource,
    broadcast: BroadcastFn,
    statusRepo: IStatusRepository,
    debounceMs: number = webhookDebounceMs(),
    fallbackMs: number = webhookFallbackMs(),
  ) {
    super(projectId, source, broadcast, statusRepo)
    this.debounceMs = debounceMs
    this.fallbackMs = fallbackMs
  }

  start(dispatch: (item: IssueItem) => Promise<void>): Disposable {
    this.dispatchFn = dispatch
    const unregister = registerWebhookTarget({
      projectId: this.projectId,
      matches: (hint) => this.matches(hint),
      trigger: (reason) => this.trigger(reason),
      stats: () => this.stats(),
    })

    // Catch-up scan: whatever moved while the daemon was down produced
    // webhooks nobody received.
    void this.onDaemonStart().then(() => this.scan('startup'))

    // One timer at the *fast* cadence; each tick decides whether a fallback
    // scan is actually due (see fallbackDue). fallbackMs = 0 opts out entirely.
    const tickMs = Math.min(this.fallbackMs, pollIntervalMs())
    const timer = this.fallbackMs > 0 ? setInterval(() => this.trigger('fallback'), tickMs) : null

    log.info(
      {
        projectId: this.projectId,
        debounceMs: this.debounceMs,
        fallbackMs: this.fallbackMs,
        warmupIntervalMs: tickMs,
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

  /**
   * Is a fallback scan due? Before the first delivery every tick is due (we
   * can't tell a quiet board from a hook that was never configured, and
   * guessing wrong means tasks sit unattended). Afterwards, only once the slow
   * interval has elapsed since the last scan.
   */
  private fallbackDue(): boolean {
    if (!this.deliveryReceived) return true
    return Date.now() - this.lastScanStartedMs >= this.fallbackMs
  }

  /**
   * Queue a scan. Debounced so an event burst produces one cycle. A `fallback`
   * trigger is a *request*: it's declined when the slow interval hasn't elapsed
   * since the last scan (see fallbackDue).
   */
  trigger(reason: string): void {
    if (this.stopped) return
    if (reason.startsWith('fallback') && !this.fallbackDue()) return
    if (!reason.startsWith('fallback') && !this.deliveryReceived) {
      this.deliveryReceived = true
      log.info(
        { projectId: this.projectId, reason, fallbackMs: this.fallbackMs },
        'First webhook delivery received — relaxing fallback to the slow interval',
      )
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
    this.lastScanStartedMs = Date.now()
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
