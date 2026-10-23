/**
 * Cuándo y cuántas veces se retoma una ejecución que el proceso cortó mientras corría. Si lo que
 * mató al proceso fue la propia corrida (memoria, un comando que lo tumba), retomarlas todas en
 * el acto lo vuelve a tumbar: la espera crece con cada intento y se escalonan entre sí.
 */
export interface ResumeLimits {
  /** Cuántas veces seguidas se retoma una. */
  maxAttempts: number
  /** Si el checkpoint es más viejo que esto, no se retoma. */
  maxAgeMs: number
  /** La espera del segundo intento; se duplica en cada uno que sigue. El primero no espera. */
  backoffMs: number
  /** El techo de esa espera. */
  maxBackoffMs: number
  /** Cuánto después de la anterior arranca cada una que se retoma en el mismo reinicio. */
  staggerMs: number
}

export const DEFAULT_RESUME_LIMITS: ResumeLimits = {
  maxAttempts: 10,
  maxAgeMs: 24 * 60 * 60 * 1000,
  backoffMs: 30_000,
  maxBackoffMs: 30 * 60_000,
  staggerMs: 60_000,
}

/**
 * Cuánto espera para retomarse la `index`-ésima (desde 0) que se retoma en este reinicio, en su
 * intento `attempt` (desde 1): 0 la primera vez, después `backoffMs` duplicándose hasta
 * `maxBackoffMs`; más `staggerMs` por cada una que va antes.
 */
export function resumeDelayMs(attempt: number, index: number, limits: ResumeLimits): number {
  const backoff =
    attempt <= 1 ? 0 : Math.min(limits.backoffMs * 2 ** (attempt - 2), limits.maxBackoffMs)
  return backoff + index * limits.staggerMs
}
