/**
 * Un fallo de infraestructura —un límite de tasa, un 5xx, la red— no es un fallo de la task: el
 * mismo paso, más tarde, puede andar. Quien tira lo marca con `transient: true` en el error (un
 * flag, no una clase: el engine no conoce a GitHub ni a nadie); el engine no le corre el `onError`
 * (el `+blocked` del proyecto) y vuelve a despachar el evento más tarde (`TransientRetries`).
 * Recién el último intento corre el `onError` como cualquier otro fallo.
 */
import type { DomainEvent } from '../events/DomainEvent.js'

/** Cuántas veces se re-despacha un evento por un fallo transitorio antes de tratarlo como uno más. */
export const MAX_TRANSIENT_RETRIES = 3

type Flagged = { transient?: unknown; retryAfterMs?: unknown; cause?: unknown }

/** Si `err` es transitorio: él, su `cause`, o —un `AggregateError`— todas sus causas. */
export function isTransient(err: unknown, depth = 0): boolean {
  if (depth > 5 || typeof err !== 'object' || err === null) return false
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors.every((cause) => isTransient(cause, depth + 1))
  }
  const flagged = err as Flagged
  if (flagged.transient === true) return true
  return isTransient(flagged.cause, depth + 1)
}

/** El mayor `retryAfterMs` que dijo alguna causa de `err` (cuánto pidió esperar el upstream). */
export function retryAfterMsOf(err: unknown, depth = 0): number | undefined {
  if (depth > 5 || typeof err !== 'object' || err === null) return undefined
  const own = (err as Flagged).retryAfterMs
  const causes =
    err instanceof AggregateError ? err.errors : [(err as Flagged).cause].filter(Boolean)
  const all = [
    typeof own === 'number' ? own : undefined,
    ...causes.map((c) => retryAfterMsOf(c, depth + 1)),
  ]
  const known = all.filter((value): value is number => value !== undefined)
  return known.length > 0 ? Math.max(...known) : undefined
}

/** Los errores cuyo `onError` se saltó porque la corrida se va a reintentar (`StepRunner`). */
const deferred = new WeakSet<object>()
/** Los errores cuyo reintento ya se programó (`TransientRetries`). */
const scheduled = new WeakSet<object>()

/** `err` no corrió su `onError`: la corrida se reintenta. Lo marca `StepRunner`. */
export function markDeferred(err: unknown): void {
  if (typeof err === 'object' && err !== null) deferred.add(err)
}

/** El reintento de `err` ya se programó. */
export function markScheduled(err: unknown): void {
  if (typeof err === 'object' && err !== null) scheduled.add(err)
}

function causesOf(err: object): unknown[] {
  if (err instanceof AggregateError) return err.errors
  const cause = (err as Flagged).cause
  return cause === undefined ? [] : [cause]
}

function anyDeferred(err: unknown, depth: number): boolean {
  if (depth > 6 || typeof err !== 'object' || err === null) return false
  return deferred.has(err) || causesOf(err).some((cause) => anyDeferred(cause, depth + 1))
}

function allScheduled(err: unknown, depth: number): boolean {
  if (depth > 6 || typeof err !== 'object' || err === null) return false
  if (scheduled.has(err)) return true
  const causes = causesOf(err)
  return causes.length > 0 && causes.every((cause) => allScheduled(cause, depth + 1))
}

/**
 * Si la corrida que tiró `err` se tiene que programar para reintentarse: algún paso difirió su
 * `onError` por esto, y no es sólo el eco de corridas ya programadas — el `emit` de un padre que
 * falla porque falló su hijo no se reintenta: se reintenta el hijo, que es más preciso (el padre
 * re-emitiría también a los que anduvieron).
 */
export function needsRetry(err: unknown): boolean {
  return anyDeferred(err, 0) && !allScheduled(err, 0)
}

/** Si a `event` todavía le queda un re-despacho por fallo transitorio. */
export function retriesLeft(event: DomainEvent<any>): boolean {
  return (event.transientRetries ?? 0) < MAX_TRANSIENT_RETRIES
}
