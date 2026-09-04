// Compartido entre el provider principal (loop de agente) y cualquier otro
// caller que necesite hablar con la Anthropic API.

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

/**
 * Versión del wire protocol. Fijada en un solo lugar para que todos los
 * callers manden la misma header.
 */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Betas por default que activan capabilities Claude Code / OAuth / caching.
 */
export const CLAUDE_CODE_BETAS: readonly string[] = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
]

export function buildAnthropicAuthHeader(): Record<string, string> {
  const oauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  if (oauthToken) return { Authorization: `Bearer ${oauthToken}` }
  if (apiKey) return { 'x-api-key': apiKey }
  throw new Error('No auth configured: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY')
}

/**
 * Construye el bloque de headers estándar que usan TODOS los callers a la
 * Anthropic API. `betas` es la lista base (default: `CLAUDE_CODE_BETAS`) —
 * el provider principal pasa la suya propia (`cfg.anthropicBeta`, editable
 * vía providers.json) en vez del default fijo. `extraBetas` son betas que
 * un caller agrega condicionalmente por request (ej. `task-budgets-2026-03-13`
 * sólo si el agente pidió `taskBudgetTokens`, `mcp-client-2025-11-20` sólo si
 * hay `mcp_servers`), sin pisar la lista base.
 */
export function buildAnthropicHeaders(
  opts: {
    betas?: readonly string[]
    extraBetas?: readonly string[]
    version?: string
  } = {},
): Record<string, string> {
  const betas = new Set<string>(opts.betas ?? CLAUDE_CODE_BETAS)
  for (const b of opts.extraBetas ?? []) betas.add(b)
  return {
    'content-type': 'application/json',
    'anthropic-version': opts.version ?? ANTHROPIC_VERSION,
    'anthropic-beta': [...betas].join(','),
    ...buildAnthropicAuthHeader(),
  }
}

/**
 * El único punto donde el paquete llama `fetch` contra la Messages API.
 * Serializa el body y arma el request — no clasifica errores de red ni lee
 * la respuesta, porque cada caller necesita distinto manejo ahí (el
 * provider principal reintenta streaming + clasifica aborts propios vs
 * upstream; el classifier de providers usa un timeout fijo y degrada a
 * `null`). Mantiene URL/method/serialización en un solo lugar para que
 * ningún caller nuevo tenga que repetirlos.
 */
export function requestAnthropicApi(
  body: unknown,
  opts: { headers: Record<string, string>; signal?: AbortSignal },
): Promise<Response> {
  return fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: opts.headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  })
}

/** HTTP statuses worth retrying: rate limiting and transient upstream
 *  failures. `400`/`401`/`403`/`404` are config/auth bugs — retrying them
 *  only delays the diagnosis, so they're deliberately excluded. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])

export interface AnthropicRetryInfo {
  /** 1-indexed attempt number about to be made (2 = first retry). */
  attempt: number
  maxRetries: number
  delayMs: number
  status?: number
  error?: unknown
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Tope duro para un `retry-after` — un 429 de una org saturada puede pedir
 *  minutos de espera, y honrarlo tal cual retendría el lock de la task, el
 *  worktree y el slot del provider por todo ese tiempo. */
const MAX_RETRY_AFTER_MS = 60_000

/** Exponential backoff with jitter, honoring `retry-after` (seconds, capped
 *  at `MAX_RETRY_AFTER_MS`) when the upstream sends one — a 429 telling us
 *  how long to wait shouldn't be second-guessed by our own schedule, but
 *  shouldn't be trusted unbounded either. */
export function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    }
  }
  const base = Math.min(250 * 2 ** attempt, 8000)
  return base + Math.random() * base
}

/**
 * Wraps `requestAnthropicApi` with retries for transient failures — a
 * `429`/`529`/`5xx` response or a connection-level error. Backs off
 * exponentially (with jitter), honoring `retry-after` when present, and
 * stops immediately if `opts.signal` is aborted — an operator abort cuts
 * the retry chain, not just the in-flight wait. Non-retryable statuses
 * (anything not in `RETRYABLE_STATUSES`) and exhausted retries return/throw
 * exactly like a single `requestAnthropicApi` call would.
 */
export async function requestAnthropicApiWithRetry(
  body: unknown,
  opts: {
    headers: Record<string, string>
    signal?: AbortSignal
    /** Max retry attempts after the first try. Default 0 (no retry) — the
     *  provider resolves and passes its own configured value. */
    maxRetries?: number
    onRetry?: (info: AnthropicRetryInfo) => void
  },
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 0
  let attempt = 0
  while (true) {
    let res: Response
    try {
      res = await requestAnthropicApi(body, { headers: opts.headers, signal: opts.signal })
    } catch (err) {
      if (opts.signal?.aborted || attempt >= maxRetries) throw err
      const delayMs = backoffMs(attempt, null)
      opts.onRetry?.({ attempt: attempt + 2, maxRetries, delayMs, error: err })
      await sleep(delayMs, opts.signal)
      attempt++
      continue
    }
    if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt >= maxRetries) return res
    const delayMs = backoffMs(attempt, res.headers.get('retry-after'))
    opts.onRetry?.({ attempt: attempt + 2, maxRetries, delayMs, status: res.status })
    // Nadie va a leer este body — liberá la conexión antes de esperar en vez
    // de dejarla colgada hasta que el GC la junte.
    await res.body?.cancel().catch(() => {})
    await sleep(delayMs, opts.signal)
    attempt++
  }
}
