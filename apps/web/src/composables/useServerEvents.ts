// Shared WebSocket client for realtime events broadcast by the server:
// task:updated, execution:started, execution:updated, log:entry, etc.
//
// One socket per browser tab regardless of how many components subscribe —
// each caller registers a handler and gets a matching unregister on unmount.
// Reconnects automatically with a bounded backoff while any handler is alive.

import { wsOrigin } from '@/features/servers/selection'
import { onBeforeUnmount, onMounted, ref } from 'vue'

export type ServerEvent =
  | { type: 'connected' }
  | { type: 'task:updated'; task: unknown }
  | { type: 'execution:started'; log: unknown }
  | { type: 'execution:updated'; log: unknown }
  | { type: 'log:entry'; entry: unknown }
  // Fallback so callers can still surface unknown types without a cast.
  | { type: string; [k: string]: unknown }

type Handler = (msg: ServerEvent) => void

const handlers = new Set<Handler>()
let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 15000

// `connected` is module-level so multiple callers share the same reactive
// signal (all their toggles reflect the same live status).
const connected = ref(false)

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  // wsOrigin(), no location.host: al mirar otro server los eventos en vivo
  // tienen que venir de ESE daemon, no del que sirve esta página.
  return `${proto}//${wsOrigin()}/ws`
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return
  if (handlers.size === 0) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
    openSocket()
  }, reconnectDelay)
}

function openSocket() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return
  }
  socket = new WebSocket(wsUrl())
  socket.onopen = () => {
    connected.value = true
    reconnectDelay = 1000
  }
  socket.onmessage = (ev) => {
    let msg: ServerEvent
    try {
      msg = JSON.parse(ev.data) as ServerEvent
    } catch {
      return
    }
    for (const h of handlers) {
      try {
        h(msg)
      } catch {
        /* one handler must not break the others */
      }
    }
  }
  socket.onerror = () => {
    // onclose will handle the reconnect — don't schedule twice.
  }
  socket.onclose = () => {
    connected.value = false
    socket = null
    scheduleReconnect()
  }
}

function closeSocket() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (socket) {
    socket.onclose = null
    socket.close()
    socket = null
  }
  connected.value = false
}

export interface UseServerEventsOptions {
  /**
   * `false` = ni te suscribas ni abras el socket.
   *
   * Existe porque no todo lo que la app puede estar mirando emite eventos: un
   * agent-host no expone `/ws`. Sin esto, la única forma de "no escuchar" era
   * un `return` dentro del handler — que NO evita nada: el socket se abre
   * igual, cierra, y `scheduleReconnect` reintenta para siempre mientras haya
   * un handler vivo.
   *
   * Se lee una vez, al montar, y no es reactivo a propósito: cambiar de
   * proceso pasa por una recarga completa de la página.
   */
  enabled?: boolean
}

export function useServerEvents(handler: Handler, opts: UseServerEventsOptions = {}) {
  const enabled = opts.enabled ?? true

  onMounted(() => {
    if (!enabled) return
    handlers.add(handler)
    openSocket()
  })
  onBeforeUnmount(() => {
    if (!enabled) return
    handlers.delete(handler)
    if (handlers.size === 0) closeSocket()
  })

  return { connected }
}
