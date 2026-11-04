/**
 * Cuándo una respuesta de GitHub es un límite de tasa y cuánto esperar antes de reintentarla —
 * puro, sin reloj propio (`now` entra por parámetro).
 *
 * GitHub tiene dos límites: el primario (la cuota por hora, `x-ratelimit-remaining: 0`) y el
 * secundario, el de ráfagas (demasiados requests juntos, demasiadas mutaciones por minuto, mucha
 * concurrencia): un 403 —o un 429— con "You have exceeded a secondary rate limit" en el body y,
 * a veces, `retry-after`. Los dos se reintentan; cualquier otro 403 es un permiso que falta.
 */

/** Lo que se mira de una respuesta: el status, los headers y el body (ya leído). */
export interface RateLimitSignal {
  status: number
  headers: Headers
  body: string
}

/** El backoff cuando GitHub no dice cuánto esperar: lo que pide su doc para el secundario. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000

/** ¿`signal` es un límite de tasa (primario o secundario), y no un 403 de permisos? */
export function isRateLimited(signal: RateLimitSignal): boolean {
  if (signal.status === 429) return true
  if (signal.status !== 403) return false
  if (signal.headers.get('retry-after') !== null) return true
  if (signal.headers.get('x-ratelimit-remaining') === '0') return true
  return /rate limit/i.test(signal.body)
}

/**
 * Cuánto esperar antes del reintento número `attempt` (1, 2, …): lo que diga GitHub
 * (`retry-after` en segundos, o el `x-ratelimit-reset` de una cuota agotada) y, si no dice nada,
 * `DEFAULT_RATE_LIMIT_WAIT_MS` duplicado por intento. Siempre con jitter (`random` ∈ [0, 1)) para
 * que los requests que chocaron juntos no vuelvan juntos.
 */
export function rateLimitWaitMs(
  headers: Headers,
  attempt: number,
  now: number,
  random: () => number,
): number {
  const jitter = (base: number) => base + Math.floor(random() * Math.min(base * 0.2, 10_000))
  const retryAfter = Number(headers.get('retry-after') ?? Number.NaN)
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return jitter(retryAfter * 1000)
  const reset = Number(headers.get('x-ratelimit-reset') ?? Number.NaN)
  if (headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) {
    return jitter(Math.max(0, reset * 1000 - now))
  }
  return jitter(DEFAULT_RATE_LIMIT_WAIT_MS * 2 ** Math.max(0, attempt - 1))
}

/** El 5xx de un gateway que se cae un rato: se reintenta, pero sólo si el request es idempotente. */
export function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}
