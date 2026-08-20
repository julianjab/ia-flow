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

const listeners = new Set<(snap: RateLimitSnapshot) => void>()

function sameSnapshot(a: RateLimitSnapshot, b: RateLimitSnapshot): boolean {
  return (
    a.limited === b.limited &&
    a.resource === b.resource &&
    a.resetAt === b.resetAt &&
    a.limit === b.limit &&
    a.remaining === b.remaining &&
    a.message === b.message
  )
}

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
    // Nothing currently limited — still surface live counters (e.g. for a
    // header chip) instead of blanking them out. Pick whichever resource is
    // proportionally closest to exhausted, same "worst case wins" rule as
    // the limited branch below, so a REST call (budget of 60) never masks
    // a GraphQL budget (5000) sitting near zero, or vice versa.
    let worst: { key: RateLimitResource; s: ResourceState; ratio: number } | null = null
    for (const key of Object.keys(perResource) as RateLimitResource[]) {
      const s = perResource[key]
      if (s.remaining === null || s.limit === null || s.limit === 0) continue
      const ratio = s.remaining / s.limit
      if (!worst || ratio < worst.ratio) worst = { key, s, ratio }
    }
    if (worst) {
      return {
        limited: false,
        resource: worst.key,
        resetAt: worst.s.resetAt,
        limit: worst.s.limit,
        remaining: worst.s.remaining,
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

// `remaining` decrements on essentially every GitHub response, so a naive
// "emit whenever the snapshot changed" still broadcasts once per request
// for whichever resource has the tightest budget (REST: 60/hr fills up
// fast). Trailing-edge throttle coalesces those into one WS message per
// window; `limited`-flag flips bypass the throttle and emit immediately —
// those are rare and the banner/dispatcher need them right away.
const EMIT_THROTTLE_MS = 3000
let lastEmitAt = 0
let pendingEmit: ReturnType<typeof setTimeout> | null = null

function scheduleEmit(urgent: boolean) {
  if (urgent) {
    if (pendingEmit) {
      clearTimeout(pendingEmit)
      pendingEmit = null
    }
    lastEmitAt = Date.now()
    emit()
    return
  }
  const now = Date.now()
  const elapsed = now - lastEmitAt
  if (elapsed >= EMIT_THROTTLE_MS) {
    lastEmitAt = now
    emit()
    return
  }
  if (!pendingEmit) {
    pendingEmit = setTimeout(() => {
      pendingEmit = null
      lastEmitAt = Date.now()
      emit()
    }, EMIT_THROTTLE_MS - elapsed)
  }
}

export function getRateLimit(): RateLimitSnapshot {
  // Auto-clear elapsed windows on read. Emits so WS subscribers get told
  // the limit lifted even if no new GitHub request has hit the client yet.
  const before = snapshot()
  autoClear()
  const after = snapshot()
  if (before.limited !== after.limited) scheduleEmit(true)
  else if (!sameSnapshot(before, after)) scheduleEmit(false)
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
  const before = snapshot()
  const nowLimited = remainingN === 0 && !!resetN
  perResource[resource] = {
    limited: nowLimited,
    resetAt: resetN ?? prev.resetAt,
    limit: limitN ?? prev.limit,
    remaining: remainingN ?? prev.remaining,
    message: nowLimited ? (prev.message ?? `${resource} rate limit exhausted`) : null,
  }
  // A header counter needs live remaining/limit numbers, not just the
  // limited-flag transition — but throttle those (see scheduleEmit) so a
  // burst of same-resource calls doesn't broadcast to every connected
  // client on every single GitHub request.
  const after = snapshot()
  if (before.limited !== after.limited) scheduleEmit(true)
  else if (!sameSnapshot(before, after)) scheduleEmit(false)
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
  const before = snapshot()
  perResource[resource] = {
    limited: true,
    resetAt: resetAt ?? prev.resetAt,
    limit: prev.limit,
    remaining: 0,
    message,
  }
  if (!sameSnapshot(before, snapshot())) scheduleEmit(true)
}
