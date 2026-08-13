// In-memory GitHub rate-limit state shared by the GraphQL/REST client and
// the polling loop. When we detect a 403/429 rate-limit response (or read
// `x-ratelimit-remaining: 0`), we stash the reset epoch here so:
//   · client.gql/rest can short-circuit with a typed error before spending
//     another request against the same window.
//   · PollingIssueManager can skip whole cycles until the window resets,
//     instead of hammering GitHub every 30s.
//   · The web can render a banner to explain why nothing is polling.

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

let state: RateLimitSnapshot = {
  limited: false,
  resource: null,
  resetAt: null,
  limit: null,
  remaining: null,
  message: null,
}

const listeners = new Set<(snap: RateLimitSnapshot) => void>()

function emit() {
  const snap = getRateLimit()
  for (const l of listeners) {
    try {
      l(snap)
    } catch {
      /* isolate */
    }
  }
}

export function getRateLimit(): RateLimitSnapshot {
  // Auto-clear when the reset window has elapsed. Caller reads always see
  // fresh truth; no need for a background timer. Emits so WS subscribers
  // (banner in the web) get told the limit lifted even if no new GitHub
  // request has hit the client yet.
  if (state.limited && state.resetAt && Date.now() / 1000 >= state.resetAt) {
    state = { ...state, limited: false, message: null }
    emit()
  }
  return { ...state }
}

export function isRateLimited(): boolean {
  return getRateLimit().limited
}

export function onRateLimitChange(fn: (snap: RateLimitSnapshot) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Read `x-ratelimit-*` from any GitHub response. GitHub returns these on
// every REST call and on GraphQL responses too. `resource` tells us which
// budget we just touched — GraphQL and REST are separate.
export function updateFromHeaders(headers: Headers, resource: RateLimitResource) {
  const remaining = headers.get('x-ratelimit-remaining')
  const limit = headers.get('x-ratelimit-limit')
  const reset = headers.get('x-ratelimit-reset')
  if (remaining === null && reset === null) return

  const remainingN = remaining !== null ? Number.parseInt(remaining, 10) : null
  const limitN = limit !== null ? Number.parseInt(limit, 10) : null
  const resetN = reset !== null ? Number.parseInt(reset, 10) : null

  const wasLimited = state.limited
  const nowLimited = remainingN === 0 && !!resetN

  state = {
    limited: nowLimited,
    resource: nowLimited ? resource : wasLimited ? state.resource : null,
    resetAt: resetN,
    limit: limitN,
    remaining: remainingN,
    message: nowLimited ? (state.message ?? `${resource} rate limit exhausted`) : null,
  }

  if (nowLimited !== wasLimited) emit()
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
  const wasLimited = state.limited
  state = {
    limited: true,
    resource,
    resetAt: resetAt ?? state.resetAt,
    limit: state.limit,
    remaining: 0,
    message,
  }
  if (!wasLimited) emit()
}
