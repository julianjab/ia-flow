import type { DevicePoll, GithubUserToken } from '@ia-flow/shared'

// La lógica del device flow, sin Vue ni red: el componente le inyecta el sondeo
// y el reloj, y los tests le inyectan los suyos.

/** Cómo renovar el token, si GitHub lo hace vencer (ver `stores/githubSession`). */
type Renewal = Partial<
  Pick<GithubUserToken, 'expires_in' | 'refresh_token' | 'refresh_token_expires_in'>
>

/** GitHub pide sumar 5 s al intervalo cada vez que contesta `slow_down`. */
export const SLOW_DOWN_STEP_S = 5
const MAX_CONSECUTIVE_FAILURES = 3

export type DeviceOutcome =
  | ({ status: 'ok'; token: string; login: string } & Renewal)
  | { status: 'denied' | 'expired' | 'cancelled' }
  | { status: 'error'; message: string }

export interface PollOptions {
  deviceCode: string
  /** Segundos entre sondeos, como los pidió GitHub. */
  interval: number
  /** Segundos de vida del código. */
  expiresIn: number
  poll: (deviceCode: string) => Promise<DevicePoll>
  /** Inyectable: los tests no esperan de verdad. Resuelve al cumplirse `ms` o al abortar. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
  now?: () => number
  /** Avisa cada vez que cambia el intervalo (por un `slow_down`). */
  onInterval?: (seconds: number) => void
}

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done)
  })
}

type PollStep = { result: DevicePoll } | { error: unknown }

async function tryPoll(opts: PollOptions): Promise<PollStep> {
  try {
    return { result: await opts.poll(opts.deviceCode) }
  } catch (error) {
    return { error }
  }
}

/** `slow_down` suma 5 s al intervalo y lo avisa; cualquier otra respuesta lo deja igual. */
function nextInterval(
  interval: number,
  result: DevicePoll,
  onInterval?: (seconds: number) => void,
): number {
  if (result.status !== 'slow_down') return interval
  onInterval?.(interval + SLOW_DOWN_STEP_S)
  return interval + SLOW_DOWN_STEP_S
}

/** Cancelado por el usuario o vencido por reloj: no hay nada más que sondear. */
function interrupted(signal: AbortSignal | undefined, past: boolean): DeviceOutcome | null {
  if (signal?.aborted) return { status: 'cancelled' }
  return past ? { status: 'expired' } : null
}

function failure(error: unknown): DeviceOutcome {
  return { status: 'error', message: error instanceof Error ? error.message : String(error) }
}

/** Un sondeo terminal → su desenlace; `null` = todavía no hay nada que decir. */
function toOutcome(result: DevicePoll): DeviceOutcome | null {
  switch (result.status) {
    case 'ok':
      return result.access_token && result.login
        ? {
            status: 'ok',
            token: result.access_token,
            login: result.login,
            ...renewalOf(result),
          }
        : { status: 'error', message: 'El runner confirmó el login sin token.' }
    case 'denied':
    case 'expired':
      return { status: result.status }
    default:
      return null
  }
}

function renewalOf(result: DevicePoll): Renewal {
  return {
    ...(result.expires_in !== undefined ? { expires_in: result.expires_in } : {}),
    ...(result.refresh_token ? { refresh_token: result.refresh_token } : {}),
    ...(result.refresh_token_expires_in !== undefined
      ? { refresh_token_expires_in: result.refresh_token_expires_in }
      : {}),
  }
}

/**
 * Sondea hasta que el usuario autoriza, rechaza, vence el código o se cancela.
 *
 * - `pending`: sigue, al mismo ritmo.
 * - `slow_down`: sigue, con 5 s más de intervalo.
 * - `ok`: termina; sin `access_token` y `login` no es un `ok` utilizable.
 * - fallas de red: se toleran tres seguidas (un runner que reinicia no debería
 *   tirar un login a medias), a la cuarta se reporta.
 */
export async function pollUntilDone(opts: PollOptions): Promise<DeviceOutcome> {
  const sleep = opts.sleep ?? sleepMs
  const now = opts.now ?? Date.now
  const deadline = now() + opts.expiresIn * 1000
  let interval = opts.interval
  let failures = 0

  while (true) {
    await sleep(interval * 1000, opts.signal)
    const stopped = interrupted(opts.signal, now() >= deadline)
    if (stopped) return stopped

    const step = await tryPoll(opts)
    if ('error' in step) {
      if (++failures > MAX_CONSECUTIVE_FAILURES) return failure(step.error)
      continue
    }
    failures = 0
    const result = step.result
    if (opts.signal?.aborted) return { status: 'cancelled' }

    interval = nextInterval(interval, result, opts.onInterval)
    const outcome = toOutcome(result)
    if (outcome) return outcome
  }
}
