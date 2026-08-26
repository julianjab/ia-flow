// GitHub GraphQL client — thin wrapper around fetch, no extra deps

import { createLogger } from '../logger.js'
import { getGitHubToken } from './credentials.js'
import {
  type RateLimitResource,
  getRateLimit,
  markRateLimited,
  updateFromHeaders,
} from './rate-limit.js'

const log = createLogger('github-client')

// e.g. "query ProjectItems(" / "mutation UpdateItemStatus(" → "ProjectItems"
function operationName(query: string): string {
  const m = query.match(/(?:query|mutation)\s+(\w+)/)
  return m?.[1] ?? 'anonymous'
}

export interface GQLResponse<T> {
  data: T
  errors?: Array<{ message: string }>
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public resource: RateLimitResource,
    public resetAt: number | null,
  ) {
    super(message)
    this.name = 'RateLimitError'
  }
}

// Fail fast when we already know the window is exhausted — no point burning
// another request that will come back with the same error.
function guardBeforeCall(resource: RateLimitResource) {
  const snap = getRateLimit()
  if (snap.limited && snap.resource === resource) {
    throw new RateLimitError(
      snap.message ?? `GitHub ${resource} rate limit exhausted`,
      resource,
      snap.resetAt,
    )
  }
}

function looksLikeRateLimit(msg: string): boolean {
  const m = msg.toLowerCase()
  return m.includes('rate limit') || m.includes('secondary rate') || m.includes('abuse detection')
}

export async function gql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const token = await getGitHubToken()
  if (!token)
    throw new Error('No hay credencial de GitHub configurada (ver IA_FLOW_GITHUB_AUTH_MODE)')

  guardBeforeCall('graphql')

  const op = operationName(query)
  const startedAt = performance.now()
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ia-flow/1.0',
    },
    body: JSON.stringify({ query, variables }),
  })

  updateFromHeaders(res.headers, 'graphql')
  log.info(
    {
      op,
      variables,
      status: res.status,
      durationMs: Math.round(performance.now() - startedAt),
      remaining: res.headers.get('x-ratelimit-remaining'),
      limit: res.headers.get('x-ratelimit-limit'),
    },
    `github graphql ${op}`,
  )

  if (!res.ok) {
    const text = await res.text()
    if (res.status === 403 || res.status === 429 || looksLikeRateLimit(text)) {
      const reset = Number.parseInt(res.headers.get('x-ratelimit-reset') ?? '', 10)
      markRateLimited(
        'graphql',
        text || `HTTP ${res.status}`,
        Number.isFinite(reset) ? reset : null,
      )
    }
    throw new Error(`GitHub API HTTP ${res.status}: ${text}`)
  }

  const json = (await res.json()) as GQLResponse<T>
  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join('; ')
    if (looksLikeRateLimit(msg)) {
      const reset = Number.parseInt(res.headers.get('x-ratelimit-reset') ?? '', 10)
      markRateLimited('graphql', msg, Number.isFinite(reset) ? reset : null)
    }
    throw new Error(`GitHub GraphQL errors: ${msg}`)
  }

  return json.data
}

// GitHub REST client for simple operations
export async function rest(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const token = await getGitHubToken()
  if (!token)
    throw new Error('No hay credencial de GitHub configurada (ver IA_FLOW_GITHUB_AUTH_MODE)')

  guardBeforeCall('rest')

  const startedAt = performance.now()
  const res = await fetch(`https://api.github.com${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ia-flow/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  updateFromHeaders(res.headers, 'rest')
  log.info(
    {
      method: options.method ?? 'GET',
      path,
      status: res.status,
      durationMs: Math.round(performance.now() - startedAt),
      remaining: res.headers.get('x-ratelimit-remaining'),
      limit: res.headers.get('x-ratelimit-limit'),
    },
    `github rest ${options.method ?? 'GET'} ${path}`,
  )

  if (!res.ok) {
    const text = await res.text()
    if (res.status === 403 || res.status === 429 || looksLikeRateLimit(text)) {
      const reset = Number.parseInt(res.headers.get('x-ratelimit-reset') ?? '', 10)
      markRateLimited('rest', text || `HTTP ${res.status}`, Number.isFinite(reset) ? reset : null)
    }
    throw new Error(`GitHub REST ${options.method ?? 'GET'} ${path} → ${res.status}: ${text}`)
  }

  return res.json()
}
