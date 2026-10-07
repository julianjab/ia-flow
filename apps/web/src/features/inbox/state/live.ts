import type { EventLogEntry, RunnerStreamEvent, TraceEntry } from '@ia-flow/shared'
import { ref } from 'vue'
import { serverTarget } from '@/composables/useServerTarget'
import { connectRunnerStream, type StreamState } from '@/features/inbox/stream'

// La suscripción al stream del runner: qué hace la bandeja con cada evento. Vive dentro del
// store (`store.ts` la compone y le pasa lo que tiene que tocar).

const REFRESH_DEBOUNCE_MS = 250

export interface LiveHooks {
  refresh: () => Promise<void>
  openRef: () => string | null
  reloadOpen: (ref: string) => void
  bump: () => void
  trace: (entry: TraceEntry) => void
  event: (entry: EventLogEntry) => void
}

function streamUrl(): string {
  const target = serverTarget()
  const query = target.token ? `?token=${encodeURIComponent(target.token)}` : ''
  return `${target.url('/api/stream')}${query}`
}

/** Un refresco diferido: una ráfaga de eventos `inbox` pide una sola carga. */
function debounced(run: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const schedule = () => {
    cancel()
    timer = setTimeout(() => {
      timer = null
      run()
    }, ms)
  }
  return { schedule, cancel }
}

/** Qué hace la bandeja con un evento del stream. */
function dispatch(event: RunnerStreamEvent, hooks: LiveHooks, scheduleRefresh: () => void): void {
  if (event.type === 'inbox') {
    scheduleRefresh()
    const open = hooks.openRef()
    if (open && event.refs.includes(open)) hooks.reloadOpen(open)
  } else if (event.type === 'improvements') hooks.bump()
  else if (event.type === 'trace') hooks.trace(event.entry)
  else hooks.event(event.entry)
}

export function createLive(hooks: LiveHooks) {
  const streamState = ref<StreamState>('connecting')
  const refresh = debounced(() => void hooks.refresh(), REFRESH_DEBOUNCE_MS)
  let stream: { close(): void } | null = null

  /** Carga la bandeja y se suscribe al stream. Idempotente. */
  function start(): void {
    void hooks.refresh()
    if (stream) return
    stream = connectRunnerStream({
      url: streamUrl,
      onState: (s) => {
        streamState.value = s
      },
      onPoll: () => {
        void hooks.refresh()
        hooks.bump()
      },
      onEvent: (event) => dispatch(event, hooks, refresh.schedule),
    })
  }

  function stop(): void {
    stream?.close()
    stream = null
    refresh.cancel()
  }

  return { streamState, start, stop }
}
