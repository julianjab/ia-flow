// In-memory GitHub rate-limit state shared by the GraphQL/REST client and
// the polling loop. When we detect a 403/429 rate-limit response (or read
// `x-ratelimit-remaining: 0`), we stash the reset epoch here so:
//   · client.gql/rest can short-circuit with a typed error before spending
//     another request against the same window.
//   · PollingIssueManager can skip whole cycles until the window resets,
//     instead of hammering GitHub every 30s.
//   · The web can render a banner to explain why nothing is polling.
//
// GraphQL and REST have independent budgets on GitHub, so we track them
// separately — a fresh REST response must never flip a GraphQL limit off,
// and vice versa. The exposed snapshot aggregates: `limited` is true if
// any resource is currently limited, and `resource`/`resetAt` point to
// the one still in effect (preferring the later reset when both are).

export type RateLimitResource = 'graphql' | 'rest'

export interface RateLimitSnapshot {
  limited: boolean
  resource: RateLimitResource | null
  // Epoch seconds when the current window resets (mirrors GitHub's header).
  resetAt: number | null
  limit: number | null
  remaining: number | null
  message: string | null
}

interface ResourceState {
  limited: boolean
  resetAt: number | null
  limit: number | null
  remaining: number | null
  message: string | null
}

function empty(): ResourceState {
  return { limited: false, resetAt: null, limit: null, remaining: null, message: null }
}

const perResource: Record<RateLimitResource, ResourceState> = {
  graphql: empty(),
  rest: empty(),
}

// Most recently touched resource — lets snapshot() surface live counters
// (remaining/limit) even when nothing is currently limited, instead of
// always returning nulls until a limit actually trips.
let lastResource: RateLimitResource | null = null

const listeners = new Set<(snap: RateLimitSnapshot) => void>()

function autoClear() {
  const nowSec = Date.now() / 1000
  for (const key of Object.keys(perResource) as RateLimitResource[]) {
    const s = perResource[key]
    if (s.limited && s.resetAt && nowSec >= s.resetAt) {
      perResource[key] = { ...s, limited: false, message: null }
    }
  }
}

function snapshot(): RateLimitSnapshot {
  // Aggregate: prefer the resource still limited with the later reset, so
  // the banner surfaces the longer wait when both are exhausted.
  const candidates: Array<{ key: RateLimitResource; s: ResourceState }> = []
  for (const key of Object.keys(perResource) as RateLimitResource[]) {
    const s = perResource[key]
    if (s.limited) candidates.push({ key, s })
  }
  if (candidates.length === 0) {
    // Nothing currently limited — still surface the last-known counters
    // (e.g. for a header chip) instead of blanking them out.
    if (lastResource) {
      const s = perResource[lastResource]
      return {
        limited: false,
        resource: lastResource,
        resetAt: s.resetAt,
        limit: s.limit,
        remaining: s.remaining,
        message: null,
      }
    }
    return {
      limited: false,
      resource: null,
      resetAt: null,
      limit: null,
      remaining: null,
      message: null,
    }
  }
  candidates.sort((a, b) => (b.s.resetAt ?? 0) - (a.s.resetAt ?? 0))
  const { key, s } = candidates[0]
  return {
    limited: true,
    resource: key,
    resetAt: s.resetAt,
    limit: s.limit,
    remaining: s.remaining,
    message: s.message,
  }
}

function emit() {
  const snap = snapshot()
  for (const l of listeners) {
    try {
      l(snap)
    } catch {
      /* isolate */
    }
  }
}

export function getRateLimit(): RateLimitSnapshot {
  // Auto-clear elapsed windows on read. Emits so WS subscribers get told
  // the limit lifted even if no new GitHub request has hit the client yet.
  const before = snapshot().limited
  autoClear()
  const after = snapshot()
  if (before && !after.limited) emit()
  return after
}

export function isRateLimited(): boolean {
  return getRateLimit().limited
}

export function onRateLimitChange(fn: (snap: RateLimitSnapshot) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Read `x-ratelimit-*` from a GitHub response. Updates only the counters
// for `resource` — the other resource's state (and any active limit on it)
// is left untouched.
export function updateFromHeaders(headers: Headers, resource: RateLimitResource) {
  const remaining = headers.get('x-ratelimit-remaining')
  const limit = headers.get('x-ratelimit-limit')
  const reset = headers.get('x-ratelimit-reset')
  if (remaining === null && reset === null) return

  const remainingN = remaining !== null ? Number.parseInt(remaining, 10) : null
  const limitN = limit !== null ? Number.parseInt(limit, 10) : null
  const resetN = reset !== null ? Number.parseInt(reset, 10) : null

  const prev = perResource[resource]
  const nowLimited = remainingN === 0 && !!resetN
  lastResource = resource
  perResource[resource] = {
    limited: nowLimited,
    resetAt: resetN ?? prev.resetAt,
    limit: limitN ?? prev.limit,
    remaining: remainingN ?? prev.remaining,
    message: nowLimited ? (prev.message ?? `${resource} rate limit exhausted`) : null,
  }
  // Emit on every update, not just limited-flag transitions — a header
  // counter needs the live remaining/limit numbers, not just "did we trip".
  emit()
}

// Called when a request comes back with an explicit rate-limit error (e.g.
// GraphQL error message says "rate limit"). Overrides the "remaining>0"
// heuristic — GitHub sometimes returns `remaining>0` while the secondary
// rate limit is enforced.
export function markRateLimited(
  resource: RateLimitResource,
  message: string,
  resetAt: number | null,
) {
  const prev = perResource[resource]
  const before = snapshot().limited
  perResource[resource] = {
    limited: true,
    resetAt: resetAt ?? prev.resetAt,
    limit: prev.limit,
    remaining: 0,
    message,
  }
  if (!before) emit()
}
