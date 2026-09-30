import { randomUUID, timingSafeEqual } from 'node:crypto'
import { Condition, type ProviderRegistry } from '@ia-flow/agent-engine'
import { ChannelRouter, type RunChannel } from '@ia-flow/provider-shared'
import { createLogger } from '@ia-flow/telemetry'
import { z } from 'zod'
import {
  type AcceptRow,
  type HostTask,
  PollRequest,
  type PollResponse,
  PROTOCOL_PREFIX,
  RunReport,
  SubscribeRequest,
  type SubscribeResponse,
  TranscriptPost,
} from './protocol.js'
import { RemoteProvider } from './RemoteProvider.js'

export interface RemoteHubOptions {
  /** Donde aparecen los hosts suscritos, como `remote:<name>`. */
  registry: ProviderRegistry
  /** El bearer que presentan los hosts. Sin él, la API de hosts responde 503: nunca queda abierta
   *  por olvido. Las rutas de una corrida no lo usan: su token va en el path. */
  token: string | undefined
  /** Cuánto sin pedir tareas hasta dar un host por ido. Default: 45 s. */
  leaseMs?: number
  /** Cuánto espera un poll sin novedades antes de volver vacío. Default: 20 s. */
  longPollMs?: number
  /** Cada cuánto se barren los hosts vencidos. Default: 5 s; `0`, sólo `sweep()` (tests). */
  sweepIntervalMs?: number
  now?: () => number
  /** Lo que un host exporta con el SDK estándar (OTLP/HTTP JSON, ya parseado), para que el runner
   *  lo guarde y lo reexporte como suyo. Sin esto, esas rutas responden 404. */
  onTelemetry?: (signal: TelemetrySignal, payload: unknown) => void | Promise<void>
}

export type TelemetrySignal = 'traces' | 'logs'

/** Un host suscrito, como lo ve el runner. */
export interface HostInfo {
  name: string
  provider: string
  maxConcurrent: number
  running: number
  accepts: AcceptRow[]
  lastSeen: string
}

/** Cómo terminó la espera de una corrida remota. */
export type RemoteRunEnd =
  | { kind: 'done' }
  | { kind: 'report'; report: RunReport }
  | { kind: 'lost'; reason: string }
  | { kind: 'timeout'; minutes: number }

const DEFAULT_LEASE_MS = 45_000
const DEFAULT_LONG_POLL_MS = 20_000
const DEFAULT_SWEEP_MS = 5_000
const MAX_BODY = 5 * 1024 * 1024

/** Una corrida entregada a un host y esperada acá. */
class RemoteRunState {
  readonly ended: Promise<RemoteRunEnd>
  private finish!: (end: RemoteRunEnd) => void
  /** Polls del host que ya la vieron entregada: si la deja de listar como en curso sin
   *  reportarla, se perdió. */
  polls = 0
  delivered = false

  constructor(
    readonly task: HostTask,
    readonly channel: RunChannel,
  ) {
    this.ended = new Promise((resolve) => {
      this.finish = resolve
    })
    void channel.done.then(() => this.end({ kind: 'done' }))
  }

  end(end: RemoteRunEnd): void {
    this.finish(end)
  }
}

class HostState {
  session = randomUUID()
  lastSeen: number
  queue: HostTask[] = []
  closed: string[] = []
  readonly runs = new Map<string, RemoteRunState>()
  private waiter: (() => void) | undefined
  conditions: Condition[] = []

  constructor(
    public subscription: SubscribeRequest,
    now: number,
  ) {
    this.lastSeen = now
    this.accept(subscription)
  }

  get name(): string {
    return this.subscription.name
  }

  accept(subscription: SubscribeRequest): void {
    this.subscription = subscription
    this.conditions = Condition.fromRows(subscription.accepts)
  }

  /** Despierta al poll que espera. */
  wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  /** Hasta que haya algo para el host, o pasen `ms`. */
  wait(ms: number): Promise<void> {
    if (this.queue.length > 0 || this.closed.length > 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        resolve()
      }, ms)
      timer.unref?.()
      this.waiter = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}

/**
 * Del lado del runner, los hosts remotos: se suscriben (`remote:<name>` aparece en el registry de
 * providers), piden tareas por long-poll, y cada corrida que toman se espera en su canal — el mismo
 * de `@ia-flow/provider-shared` que usa el CLI local, montado acá en la API pública del runner. Un
 * host que deja de pedir tareas más de `leaseMs` se da por ido: sale del registry y sus corridas
 * terminan como perdidas (el engine las retoma como cualquier corrida cortada).
 *
 * Es un handler de `fetch`: el servidor del runner le pasa lo que empieza con `/v1/hosts` o
 * `/v1/runs`, y devuelve `undefined` para lo que no es suyo.
 */
export class RemoteHub {
  readonly log = createLogger('provider-remote')
  private readonly hosts = new Map<string, HostState>()
  private readonly router = new ChannelRouter()
  private readonly runs = new Map<string, RemoteRunState>()
  private readonly now: () => number
  private readonly timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: RemoteHubOptions) {
    this.now = options.now ?? Date.now
    const every = options.sweepIntervalMs ?? DEFAULT_SWEEP_MS
    if (every > 0) {
      this.timer = setInterval(() => this.sweep(), every)
      this.timer.unref?.()
    }
  }

  get leaseMs(): number {
    return this.options.leaseMs ?? DEFAULT_LEASE_MS
  }

  /** Los hosts suscritos ahora. */
  list(): HostInfo[] {
    return [...this.hosts.values()].map((host) => ({
      name: host.name,
      provider: providerId(host.name),
      maxConcurrent: host.subscription.maxConcurrent,
      running: host.runs.size,
      accepts: host.subscription.accepts,
      lastSeen: new Date(host.lastSeen).toISOString(),
    }))
  }

  /** @internal lo usa `RemoteProvider`. */
  host(name: string): HostState | undefined {
    return this.hosts.get(name)
  }

  /**
   * @internal Le entrega la corrida al host y la espera: hasta que el modelo cierre el turno en el
   * canal, el host reporte cómo terminó su sesión, el host se vaya, o pase `timeoutMinutes`.
   */
  async dispatch(
    name: string,
    task: HostTask,
    channel: RunChannel,
    timeoutMinutes: number,
  ): Promise<RemoteRunEnd> {
    const host = this.hosts.get(name)
    if (!host) return { kind: 'lost', reason: `el host ${name} no está suscrito` }
    const run = new RemoteRunState(task, channel)
    this.router.open(channel)
    this.runs.set(channel.token, run)
    host.runs.set(task.runId, run)
    host.queue.push(task)
    host.wake()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<RemoteRunEnd>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: 'timeout', minutes: timeoutMinutes }),
        timeoutMinutes * 60_000,
      )
      timer.unref?.()
    })
    try {
      return await Promise.race([run.ended, timeout])
    } finally {
      if (timer) clearTimeout(timer)
      this.release(host, run)
    }
  }

  /** Los hosts que no volvieron en `leaseMs`: salen del registry y sus corridas se pierden. */
  sweep(now = this.now()): void {
    for (const host of [...this.hosts.values()]) {
      if (now - host.lastSeen <= this.leaseMs) continue
      this.drop(host, `el host ${host.name} dejó de pedir tareas hace más de ${this.leaseMs} ms`)
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    for (const host of [...this.hosts.values()]) this.drop(host, 'el runner se apaga')
  }

  async fetch(req: Request): Promise<Response | undefined> {
    const path = new URL(req.url).pathname
    if (
      !path.startsWith(`${PROTOCOL_PREFIX}/hosts`) &&
      !path.startsWith(`${PROTOCOL_PREFIX}/runs`)
    ) {
      return undefined
    }
    if (req.method !== 'POST') return json(405, { error: 'sólo POST' })
    const parts = path.slice(PROTOCOL_PREFIX.length + 1).split('/')
    try {
      if (parts[0] === 'runs') return await this.onRun(parts, req)
      const denied = this.authorize(req)
      if (denied) return denied
      if (parts[1] === 'subscribe') return await this.onSubscribe(req)
      if (parts[1] === 'telemetry') return await this.onTelemetry(parts[2], req)
      if (parts[2] === 'poll' && parts[1]) return await this.onPoll(parts[1], req)
      return json(404, { error: 'ruta desconocida' })
    } catch (error) {
      if (error instanceof BadRequest) return json(400, { error: error.message })
      this.log.error(`api de hosts: ${(error as Error).message}`)
      return json(500, { error: 'error interno' })
    }
  }

  /** Un export OTLP/HTTP de un host. Sólo JSON: el exporter `-http` del SDK lo manda así. */
  private async onTelemetry(signal: string | undefined, req: Request): Promise<Response> {
    const handler = this.options.onTelemetry
    if (!handler || (signal !== 'traces' && signal !== 'logs')) {
      return json(404, { error: 'ruta desconocida' })
    }
    if (!(req.headers.get('content-type') ?? '').includes('application/json')) {
      return json(415, { error: 'sólo OTLP/HTTP JSON' })
    }
    await handler(signal, await body(req))
    return json(200, {})
  }

  private async onSubscribe(req: Request): Promise<Response> {
    const subscription = parse(SubscribeRequest, await body(req))
    const existing = this.hosts.get(subscription.name)
    const host = existing ?? new HostState(subscription, this.now())
    if (existing) {
      // El mismo host que vuelve (se reinició, se cortó la red): sesión nueva, sus corridas siguen.
      existing.accept(subscription)
      existing.session = randomUUID()
      existing.lastSeen = this.now()
    } else {
      this.hosts.set(host.name, host)
      this.options.registry.register(new RemoteProvider({ hub: this, host: host.name }))
      this.log.info(
        `host ${host.name} suscrito: ${providerId(host.name)}, hasta ${subscription.maxConcurrent} a la vez`,
      )
    }
    const response: SubscribeResponse = {
      session: host.session,
      provider: providerId(host.name),
      leaseMs: this.leaseMs,
    }
    return json(200, response)
  }

  private async onPoll(session: string, req: Request): Promise<Response> {
    const host = [...this.hosts.values()].find((candidate) => candidate.session === session)
    if (!host) return json(404, { error: 'sesión desconocida: volvé a suscribirte' })
    const { running } = parse(PollRequest, await body(req))
    host.lastSeen = this.now()
    this.checkRunning(host, new Set(running))
    await host.wait(this.options.longPollMs ?? DEFAULT_LONG_POLL_MS)
    host.lastSeen = this.now()
    const response: PollResponse = { tasks: host.queue.splice(0), closed: host.closed.splice(0) }
    for (const task of response.tasks) {
      const run = host.runs.get(task.runId)
      if (run) run.delivered = true
    }
    return json(200, response)
  }

  /** Una corrida entregada que el host dejó de listar en curso sin reportarla: se perdió allá
   *  (el host se reinició a mitad de camino). Se le da un poll de gracia por si el reporte viene
   *  en camino. */
  private checkRunning(host: HostState, running: Set<string>): void {
    for (const [runId, run] of host.runs) {
      if (!run.delivered || running.has(runId)) {
        run.polls = 0
        continue
      }
      if (++run.polls > 1) {
        run.end({ kind: 'lost', reason: `el host ${host.name} ya no tiene la corrida ${runId}` })
      }
    }
  }

  private async onRun(parts: string[], req: Request): Promise<Response> {
    const [, token, kind, event] = parts
    if (!token || !kind) return json(404, { error: 'corrida desconocida' })
    if (kind === 'report') {
      const run = this.runs.get(token)
      if (!run) return json(404, { error: 'corrida desconocida' })
      run.end({ kind: 'report', report: parse(RunReport, await body(req)) })
      return json(200, {})
    }
    if (kind === 'transcript') {
      const run = this.runs.get(token)
      if (!run) return json(404, { error: 'corrida desconocida' })
      const { messages } = parse(TranscriptPost, await body(req))
      for (const message of messages) run.channel.recordMessage(message)
      return json(200, {})
    }
    const reply = await this.router.handle(kind, token, event, await body(req))
    return reply.body === null
      ? new Response(null, { status: reply.status })
      : json(reply.status, reply.body)
  }

  private release(host: HostState, run: RemoteRunState): void {
    this.router.close(run.channel)
    this.runs.delete(run.channel.token)
    host.runs.delete(run.task.runId)
    // Que no la tome si todavía no la había pedido, y que corte su sesión si la tiene.
    host.queue = host.queue.filter((task) => task.runId !== run.task.runId)
    if (run.delivered) {
      host.closed.push(run.task.runId)
      host.wake()
    }
  }

  private drop(host: HostState, reason: string): void {
    this.hosts.delete(host.name)
    this.options.registry.unregister(providerId(host.name))
    for (const run of host.runs.values()) run.end({ kind: 'lost', reason })
    host.wake()
    this.log.warn(`host ${host.name} fuera: ${reason}`)
  }

  private authorize(req: Request): Response | undefined {
    const expected = this.options.token
    if (!expected) return json(503, { error: 'la API de hosts no tiene token configurado' })
    const given = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const a = Buffer.from(given)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return json(401, { error: 'no autorizado' })
    return undefined
  }
}

export function providerId(name: string): string {
  return `remote:${name}`
}

class BadRequest extends Error {}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new BadRequest(z.prettifyError(parsed.error))
  return parsed.data
}

async function body(req: Request): Promise<unknown> {
  const text = await req.text()
  if (text.length > MAX_BODY) throw new BadRequest('body demasiado grande')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new BadRequest('body no es JSON')
  }
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
