import { parseSlackEvent, type SlackSocketEvent } from './events.js'

/** Lo mínimo de un `WebSocket` (el global de Bun y Node ≥ 22) que este cliente usa. */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface SlackSocketOptions {
  /** El app-level token (`xapp-…`, scope `connections:write`), o de dónde pedirlo. NO es el bot token. */
  appToken: string | (() => string | undefined)
  /** Cada mensaje humano (mención o mensaje) una sola vez. Si tira o rechaza, se loguea y sigue. */
  onEvent: (event: SlackSocketEvent) => void | Promise<void>
  /** El id del bot (`U…`): sus propios mensajes se descartan. */
  botUserId?: string
  log?: (line: string) => void
  /** Default: `https://slack.com/api`. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  webSocketImpl?: new (url: string) => SocketLike
  /** Espera entre reconexiones: `base` × 2^intentos, hasta `max`. Default 1s → 30s. */
  backoff?: { baseMs?: number; maxMs?: number }
  /** Inyectable para no esperar de verdad en los tests. */
  delay?: (ms: number) => Promise<void>
}

/** Cuántas claves de dedupe se recuerdan: lo que Slack reintenta llega en segundos. */
const SEEN_LIMIT = 500

/**
 * Slack por Socket Mode: el runner ABRE una conexión WebSocket hacia Slack con el app token, así
 * que no hace falta una URL pública ni verificar firmas. Por cada envelope:
 *
 * 1. se le hace `ack` ENSEGUIDA (Slack reintenta lo que no se confirma en 3 segundos);
 * 2. si es un mensaje humano de la Events API, se entrega a `onEvent` una sola vez — Slack manda
 *    `app_mention` Y `message` para la misma mención, y repite la entrega si reintenta.
 *
 * La conexión se repone sola cuando Slack la cierra (`disconnect`, que avisa cada pocas horas) o se
 * cae, con espera creciente. `stop()` la cierra y no repone nada.
 */
export class SlackSocketClient {
  private socket?: SocketLike
  private stopped = true
  private attempts = 0
  /** Hubo un `hello`: sólo entonces una conexión caída se repone sola (antes, `start()` tira). */
  private connectedOnce = false
  private reconnecting = false
  private ready?: { resolve: () => void; reject: (error: Error) => void }
  private readonly seen = new Set<string>()

  constructor(private readonly options: SlackSocketOptions) {}

  /** Si hay app token: sin él, quien use el cliente puede apagarse en vez de fallar. */
  get enabled(): boolean {
    return Boolean(this.token())
  }

  /** Abre la conexión; resuelve con el `hello` de Slack y tira si la primera no se puede abrir. */
  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    try {
      await this.connect()
    } catch (error) {
      this.stopped = true
      this.socket?.close()
      this.socket = undefined
      throw error
    }
  }

  /** Cierra la conexión y no la repone. */
  stop(): void {
    this.stopped = true
    this.connectedOnce = false
    this.socket?.close()
    this.socket = undefined
  }

  private token(): string | undefined {
    const { appToken } = this.options
    return typeof appToken === 'function' ? appToken() : appToken
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  /** `apps.connections.open` y el WebSocket de la URL que devuelve, hasta su `hello`. */
  private async connect(): Promise<void> {
    const token = this.token()
    if (!token) throw new Error('Slack Socket Mode no está configurado (SLACK_APP_TOKEN)')
    const fetchImpl = this.options.fetchImpl ?? fetch
    const response = await fetchImpl(
      `${this.options.baseUrl ?? 'https://slack.com/api'}/apps.connections.open`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    )
    const body = (await response.json()) as { ok?: boolean; url?: string; error?: string }
    if (!body.ok || !body.url) {
      throw new Error(`Slack apps.connections.open: ${body.error ?? `HTTP ${response.status}`}`)
    }
    const WebSocketImpl =
      this.options.webSocketImpl ?? (WebSocket as never as new (url: string) => SocketLike)
    const socket = new WebSocketImpl(body.url)
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject }
      socket.onmessage = (message) => this.onMessage(socket, message.data)
      socket.onerror = () => this.settle(new Error('Slack Socket Mode: error de conexión'))
      socket.onclose = () => this.onClose(socket)
    })
  }

  /** Resuelve (o rechaza) `start()`/la reconexión que está esperando el `hello`. */
  private settle(error?: Error): void {
    const ready = this.ready
    this.ready = undefined
    if (error) ready?.reject(error)
    else ready?.resolve()
  }

  private onMessage(socket: SocketLike, data: unknown): void {
    let message: {
      type?: string
      envelope_id?: string
      reason?: string
      payload?: unknown
    }
    try {
      message = JSON.parse(String(data))
    } catch {
      this.log('slack-socket: mensaje que no es JSON, se ignora')
      return
    }
    if (message.type === 'hello') {
      this.attempts = 0
      this.connectedOnce = true
      this.settle()
      return
    }
    if (message.type === 'disconnect') {
      this.log(`slack-socket: Slack pidió reconectar (${message.reason ?? 'sin motivo'})`)
      socket.close()
      return
    }
    if (message.envelope_id) socket.send(JSON.stringify({ envelope_id: message.envelope_id }))
    if (message.type !== 'events_api') return
    const event = parseSlackEvent(message.payload, {
      ...(this.options.botUserId ? { botUserId: this.options.botUserId } : {}),
    })
    if (event && !this.alreadySeen(event)) this.deliver(event)
  }

  /** La misma mención llega como `app_mention` y como `message`, y un reintento repite el evento. */
  private alreadySeen(event: SlackSocketEvent): boolean {
    const keys = [`event:${event.eventId}`, `message:${event.channel}:${event.ts}`]
    const duplicated = keys.some((key) => this.seen.has(key))
    for (const key of keys) this.seen.add(key)
    while (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
    return duplicated
  }

  private deliver(event: SlackSocketEvent): void {
    Promise.resolve()
      .then(() => this.options.onEvent(event))
      .catch((error: unknown) => {
        this.log(
          `slack-socket: onEvent falló (${event.channel} ${event.ts}): ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }

  private onClose(socket: SocketLike): void {
    if (this.socket !== socket) return
    this.socket = undefined
    this.settle(new Error('Slack Socket Mode: la conexión se cerró antes del hello'))
    if (!this.stopped && this.connectedOnce && !this.reconnecting) void this.reconnect()
  }

  /** Repone la conexión con espera creciente hasta lograrlo o hasta `stop()`. */
  private async reconnect(): Promise<void> {
    const { baseMs = 1_000, maxMs = 30_000 } = this.options.backoff ?? {}
    const delay = this.options.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    this.reconnecting = true
    try {
      await this.retryUntilConnected(baseMs, maxMs, delay)
    } finally {
      this.reconnecting = false
    }
  }

  private async retryUntilConnected(
    baseMs: number,
    maxMs: number,
    delay: (ms: number) => Promise<void>,
  ): Promise<void> {
    while (!this.stopped) {
      const wait = Math.min(maxMs, baseMs * 2 ** this.attempts)
      this.attempts++
      this.log(`slack-socket: reconectando en ${wait}ms (intento ${this.attempts})`)
      await delay(wait)
      if (this.stopped) return
      try {
        await this.connect()
        return
      } catch (error) {
        this.log(
          `slack-socket: no se pudo reconectar: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
}
