// Shared plumbing for ProjectSource.watch() implementations — extracted
// after github-issues and github-project ended up with near-identical
// polling-timer and webhook-debounce/registry/stats code (~90 lines each).
// Each source keeps its OWN fast-path logic (how to turn one webhook
// delivery into SourceItems) — this module only owns the mechanism around
// it: the timer, the debounce-by-id buffer, webhook-registry wiring, and the
// stats bookkeeping GET /api/webhooks/status reads.
import type { Disposable, SourceItem, WatchOptions, WebhookMatchHint } from '../contract.js'
import type { Logger } from '../logger.js'
import { pollIntervalMs, webhookDebounceMs, webhookFallbackMs } from './env.js'
import {
  type WebhookDelivery,
  type WebhookTargetStats,
  registerWebhookTarget,
} from './webhook-registry.js'

/**
 * `mode: 'polling'` — arms a steady-state timer only, no immediate tick (the
 * boot scan is SourceDispatcher's job, not watch()'s — ticking here too
 * would duplicate it on startup).
 */
export function pollingWatch(
  fetchItems: (opts: { refresh: boolean }) => Promise<SourceItem[]>,
  onItems: (items: SourceItem[]) => void,
  opts: WatchOptions,
  log: Logger,
): Disposable {
  const intervalMs = opts.intervalMs ?? pollIntervalMs()
  const timer = setInterval(() => {
    fetchItems({ refresh: true })
      .then(onItems)
      .catch((err) => {
        log.warn({ err }, 'watch(): polling fetch failed')
        opts.onError?.(err)
      })
  }, intervalMs)
  return { dispose: () => clearInterval(timer) }
}

export interface WebhookWatchDeps {
  sourceKind: string
  opts: WatchOptions
  matchesWebhook: (hint: WebhookMatchHint) => Promise<boolean>
  /**
   * Resolve one delivery to the SourceItems it touched — the source's own
   * fast-path (build straight from the payload, or a single direct-lookup
   * fetch) with its own fallback to a full `getItems({refresh:true})` scan.
   * Called with `undefined` for a manual nudge or the optional fallback
   * timer (no real delivery behind it) — must fall back to a full scan in
   * that case too.
   */
  resolveDelivery: (delivery?: WebhookDelivery) => Promise<SourceItem[]>
  log: Logger
  /** Short label for the startup log line, e.g. "GitHub issues". */
  logScope: string
}

/**
 * `mode: 'webhook'` — registers with webhook-registry and debounces by item
 * id: a burst of events touching the same item coalesces to its latest
 * resolved state; events for different items in the same window are all
 * emitted together in one batch.
 */
export function webhookWatch(
  onItems: (items: SourceItem[]) => void,
  deps: WebhookWatchDeps,
): Disposable {
  const { sourceKind, opts, matchesWebhook, resolveDelivery, log, logScope } = deps
  const debounceMs = opts.debounceMs ?? webhookDebounceMs()
  const fallbackMs = opts.fallbackMs ?? webhookFallbackMs()

  const pending = new Map<string, SourceItem>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight = 0
  let lastEventAt: string | null = null
  let lastReason: string | null = null
  let lastScanAt: string | null = null
  let deliveryReceived = false
  let stopped = false

  const flush = () => {
    flushTimer = null
    if (!pending.size) return
    const items = [...pending.values()]
    pending.clear()
    lastScanAt = new Date().toISOString()
    onItems(items)
  }
  const scheduleFlush = () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(flush, debounceMs)
  }

  const handleDelivery = async (delivery?: WebhookDelivery): Promise<void> => {
    if (stopped) return
    inFlight++
    try {
      const items = await resolveDelivery(delivery)
      for (const item of items) pending.set(item.id, item)
      scheduleFlush()
    } catch (err) {
      log.warn({ err }, 'watch(): failed to resolve webhook delivery')
      opts.onError?.(err)
    } finally {
      inFlight--
    }
  }

  const unregister = registerWebhookTarget({
    projectId: opts.projectId,
    matches: matchesWebhook,
    trigger: (reason, delivery) => {
      if (stopped) return
      const isFallback = reason.startsWith('fallback')
      if (!isFallback) {
        lastEventAt = new Date().toISOString()
        lastReason = reason
        if (!deliveryReceived) {
          deliveryReceived = true
          log.info({ projectId: opts.projectId, reason }, 'First webhook delivery received')
        }
      }
      void handleDelivery(delivery)
    },
    stats: (): WebhookTargetStats => ({
      projectId: opts.projectId,
      sourceKind,
      lastEventAt,
      lastReason,
      lastScanAt,
      scanning: inFlight > 0,
      fallbackIntervalMs: fallbackMs,
      deliveryReceived,
    }),
  })

  const fallbackTimer =
    fallbackMs > 0 ? setInterval(() => void handleDelivery(undefined), fallbackMs) : null

  log.info(
    { projectId: opts.projectId, debounceMs, fallbackMs: fallbackMs || 'off' },
    `${logScope} watch() started (webhook mode)`,
  )

  return {
    dispose: () => {
      stopped = true
      unregister()
      if (fallbackTimer) clearInterval(fallbackTimer)
      if (flushTimer) clearTimeout(flushTimer)
    },
  }
}
