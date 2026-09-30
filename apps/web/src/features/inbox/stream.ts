import { type RunnerStreamEvent, RunnerStreamEventSchema } from '@ia-flow/shared'

// El stream del runner (`GET /api/stream`, SSE): qué cambió y, para la tarea
// abierta, las líneas de traza en vivo.
//
// Sin Vue: `connectRunnerStream` recibe todo lo que toca el mundo (la URL, el
// EventSource, los timers) para poder probarse con relojes falsos. La política:
//
//   - conectado → `live`.
//   - se cae → reintenta con backoff exponencial (1 s … 30 s).
//   - tras `FALLBACK_AFTER` fallas seguidas → `polling`: llama `onPoll` cada
//     30 s (la bandeja se refresca igual) y sigue intentando reconectar.
//   - al volver → `live` y el polling se apaga.

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'polling'

/** Lo mínimo que se usa de un `EventSource` (y lo que un test puede falsear). */
export interface EventSourceLike {
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  close(): void
}

export interface StreamOptions {
  /** Se evalúa en cada (re)conexión: el token o el server pueden haber cambiado. */
  url: () => string
  onEvent: (event: RunnerStreamEvent) => void
  onState?: (state: StreamState) => void
  /** Refresco por polling mientras el stream no anda. */
  onPoll?: () => void
  createSource?: (url: string) => EventSourceLike
  pollMs?: number
  baseDelayMs?: number
  maxDelayMs?: number
  fallbackAfter?: number
}

export const POLL_MS = 30_000
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000
export const FALLBACK_AFTER = 3

/** Una línea `data:` → evento validado; lo que no cumple el contrato se ignora. */
export function parseStreamEvent(data: string): RunnerStreamEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    return null
  }
  const parsed = RunnerStreamEventSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function backoffMs(attempt: number, base = BASE_DELAY_MS, max = MAX_DELAY_MS): number {
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1))
}

export function connectRunnerStream(opts: StreamOptions): { close(): void } {
  const create = opts.createSource ?? ((url: string) => new EventSource(url) as EventSourceLike)
  const pollMs = opts.pollMs ?? POLL_MS
  const fallbackAfter = opts.fallbackAfter ?? FALLBACK_AFTER

  let source: EventSourceLike | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let failures = 0
  let closed = false

  const setState = (s: StreamState) => opts.onState?.(s)

  function stopPolling() {
    if (pollTimer !== null) clearInterval(pollTimer)
    pollTimer = null
  }

  function startPolling() {
    if (pollTimer !== null || !opts.onPoll) return
    pollTimer = setInterval(() => opts.onPoll?.(), pollMs)
  }

  function open() {
    if (closed) return
    setState(failures === 0 ? 'connecting' : failures >= fallbackAfter ? 'polling' : 'reconnecting')
    let es: EventSourceLike
    try {
      es = create(opts.url())
    } catch {
      return fail()
    }
    source = es
    es.onopen = () => {
      failures = 0
      stopPolling()
      setState('live')
    }
    es.onmessage = (ev) => {
      const event = parseStreamEvent(ev.data)
      if (event) opts.onEvent(event)
    }
    es.onerror = () => {
      es.close()
      if (source === es) source = null
      fail()
    }
  }

  function fail() {
    if (closed) return
    failures++
    if (failures >= fallbackAfter) {
      setState('polling')
      startPolling()
    } else {
      setState('reconnecting')
    }
    retryTimer = setTimeout(open, backoffMs(failures, opts.baseDelayMs, opts.maxDelayMs))
  }

  open()

  return {
    close() {
      closed = true
      source?.close()
      source = null
      if (retryTimer !== null) clearTimeout(retryTimer)
      stopPolling()
    },
  }
}
