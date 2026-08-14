// Registry of projects listening for provider push events.
//
// WebhookIssueManager registers itself here on start() and unregisters on
// dispose(); the /api/webhooks routes look targets up and trigger their scan.
// Kept as a module-level map (not a container singleton) for the same reason
// polling-pause is: it's daemon-lifetime process state, rebuilt from scratch
// on every reloadManagers().

import { createLogger } from '../logger.js'

const log = createLogger('webhook-registry')

/**
 * What a delivery tells us about *where* the change happened. Every field is
 * optional — a hint with nothing set matches every registered target (the
 * conservative choice: better one extra scan than a missed task).
 */
export interface WebhookHint {
  /** Provider-native project node id (GitHub `projects_v2_item.project_node_id`). */
  projectNodeId?: string
  /** `owner/repo` of the repository the event came from. */
  repoFullName?: string
  /** Provider event name, for logs (`projects_v2_item`, `issues`, …). */
  event?: string
  /** Provider delivery id, for logs. */
  deliveryId?: string
}

export interface WebhookTarget {
  readonly projectId: string
  /** Does this delivery concern my project? */
  matches(hint: WebhookHint): Promise<boolean>
  /** Queue a scan cycle (debounced + coalesced by the manager). */
  trigger(reason: string): void
  /** Snapshot for GET /api/webhooks/status. */
  stats(): WebhookTargetStats
}

export interface WebhookTargetStats {
  projectId: string
  sourceKind: string
  lastEventAt: string | null
  lastReason: string | null
  lastScanAt: string | null
  scanning: boolean
  fallbackIntervalMs: number
}

const targets = new Map<string, WebhookTarget>()

/** Register a target. Returns the unregister function. */
export function registerWebhookTarget(target: WebhookTarget): () => void {
  targets.set(target.projectId, target)
  return () => {
    // Only drop it if it's still ours — a reload may have replaced the entry
    // with the next generation's manager before this dispose ran.
    if (targets.get(target.projectId) === target) targets.delete(target.projectId)
  }
}

export function listWebhookTargets(): WebhookTargetStats[] {
  return [...targets.values()].map((t) => t.stats())
}

export function hasWebhookTarget(projectId: string): boolean {
  return targets.has(projectId)
}

/**
 * Fan a delivery out to every matching target. Returns the project ids that
 * were triggered. Matching failures (network hiccup while resolving the
 * provider's project id) count as a match — a spurious scan is cheaper than a
 * dropped event.
 */
export async function deliverWebhook(hint: WebhookHint): Promise<string[]> {
  const reason = hint.event ? `webhook:${hint.event}` : 'webhook'
  const triggered: string[] = []
  await Promise.all(
    [...targets.values()].map(async (target) => {
      let matched = true
      try {
        matched = await target.matches(hint)
      } catch (err) {
        log.warn(
          { err, projectId: target.projectId, hint },
          'Webhook match check threw — scanning anyway',
        )
      }
      if (!matched) return
      target.trigger(reason)
      triggered.push(target.projectId)
    }),
  )
  log.info(
    { event: hint.event, deliveryId: hint.deliveryId, triggered },
    'Webhook delivery dispatched',
  )
  return triggered
}

/** Trigger one project by id. Returns false when it isn't in webhook mode. */
export function triggerWebhookTarget(projectId: string, reason: string): boolean {
  const target = targets.get(projectId)
  if (!target) return false
  target.trigger(reason)
  return true
}
