import { timingSafeEqual } from 'node:crypto'
import type { Admission, Provider } from '@ia-flow/agent-engine'
import { EventBus } from '@ia-flow/agent-engine'
import { createLogger, type TraceRecord } from '@ia-flow/telemetry'
import { z } from 'zod'
import { HostedRun } from './HostedRun.js'
import {
  type AdmissionHints,
  type CapacityResponse,
  hintsFromQuery,
  PROTOCOL_PREFIX,
  RunRequest,
  SyncRequest,
  toDomainEvent,
} from './protocol.js'

export interface RemoteProviderHostOptions {
  /** Los providers que se exponen, por su `id`. */
  providers: Provider[]
  /** El bearer que el runner tiene que mandar. Sin token el host rechaza TODO con 500: nunca
   *  queda abierto por olvido. */
  token: string | undefined
  /** Reglas propias de esta máquina sobre qué trabajo toma (repo, agente, …): corre en la sonda
   *  y al abrir la corrida, con las mismas pistas. Una pista que falta no debería rechazar. */
  admit?: (request: { providerId: string; hints: AdmissionHints }) => Admission
  /** Cuánto sin sync del runner hasta dar la corrida por huérfana y cortarla. Default: 120 s. */
  orphanAfterMs?: number
  /** Cuánto se guarda el resultado de una corrida que el runner no vino a buscar. Default: 10 min. */
  retainMs?: number
  /** Cuándo volver a preguntar si está al tope. Default: 30 s. */
  busyRetryMs?: number
  /** Cada cuánto se barren huérfanas y vencidas. Default: 15 s; `0`, nunca (tests: `sweep()`). */
  sweepIntervalMs?: number
}

const DEFAULT_ORPHAN_AFTER_MS = 120_000
const DEFAULT_RETAIN_MS = 10 * 60_000
const DEFAULT_BUSY_RETRY_MS = 30_000
const DEFAULT_SWEEP_INTERVAL_MS = 15_000

const PROVIDERS_PATH = `${PROTOCOL_PREFIX}/providers`
const PROVIDER_ROUTE = /^\/v1\/providers\/([^/]+)\/(capacity|runs)$/
const RUN_ROUTE = /^\/v1\/runs\/([^/]+)(\/sync)?$/
const NOT_FOUND = () => json(404, { error: 'not found' })

/**
 * El lado del host: expone `Provider`s locales por HTTP para que un runner en otra máquina los use
 * como `RemoteProvider`. Es un handler de `fetch` (`Request → Response`): se monta con
 * `Bun.serve({ fetch: host.fetch })` o detrás de cualquier router.
 *
 * El host decide sus propios topes: el `maxConcurrent` de cada provider local y `admit`. Lo que
 * no es suyo —las tools del agente— lo resuelve el runner (ver `HostedRun`).
 */
export class RemoteProviderHost {
  readonly log = createLogger('provider-remote')
  private readonly providers = new Map<string, Provider>()
  private readonly runs = new Map<string, HostedRun>()
  private readonly token: Buffer | undefined
  private readonly sweeper: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: RemoteProviderHostOptions) {
    for (const provider of options.providers) this.providers.set(provider.id, provider)
    const token = options.token?.trim()
    this.token = token ? Buffer.from(token) : undefined
    const every = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    if (every > 0) {
      this.sweeper = setInterval(() => this.sweep(), every)
      this.sweeper.unref?.()
    }
  }

  readonly fetch = async (req: Request): Promise<Response> => {
    const denied = this.authorize(req)
    if (denied) return denied
    const url = new URL(req.url)
    try {
      return await this.route(req, url)
    } catch (error) {
      if (error instanceof BadRequest) return json(400, { error: error.message })
      this.log.error(`${req.method} ${url.pathname}: ${(error as Error).message}`)
      return json(500, { error: 'error interno' })
    }
  }

  /** Corridas en curso sobre `providerId`. */
  running(providerId: string): number {
    let count = 0
    for (const run of this.runs.values()) if (run.providerId === providerId && !run.ended) count++
    return count
  }

  /**
   * Un span o log de este proceso (lo que anota el `traceRecorder` del host) para el runner de su
   * ejecución: va a cada corrida en curso de esa ejecución que pidió `observe`, como evento `trace`
   * de su sync. Lo que no es de una corrida observada se ignora. No tira.
   */
  trace(record: TraceRecord): void {
    for (const run of this.runs.values()) {
      if (run.observed && run.executionId === record.executionId) run.trace(record)
    }
  }

  /** Corta las corridas huérfanas y olvida las que terminaron hace rato. */
  sweep(now = Date.now()): void {
    const orphanAfter = this.options.orphanAfterMs ?? DEFAULT_ORPHAN_AFTER_MS
    const retain = this.options.retainMs ?? DEFAULT_RETAIN_MS
    for (const [id, run] of this.runs) {
      if (run.isOrphaned(now, orphanAfter)) {
        this.log.warn(`corrida ${id}: el runner dejó de sincronizar — se corta`)
        run.cancel('el runner dejó de sincronizar esta corrida')
      } else if (run.isExpired(now, retain)) {
        this.runs.delete(id)
      }
    }
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    for (const run of this.runs.values()) run.cancel('el host se está apagando')
  }

  private async route(req: Request, url: URL): Promise<Response> {
    if (req.method === 'GET' && url.pathname === PROVIDERS_PATH) return this.list()
    const provider = url.pathname.match(PROVIDER_ROUTE)
    if (provider?.[1] && provider[2]) {
      return this.routeProvider(req, url, decodeURIComponent(provider[1]), provider[2])
    }
    const run = url.pathname.match(RUN_ROUTE)
    if (run?.[1]) {
      const id = decodeURIComponent(run[1])
      if (req.method === 'POST' && run[2]) return this.sync(id, req)
      if (req.method === 'DELETE' && !run[2]) return this.forget(id)
    }
    return NOT_FOUND()
  }

  private async routeProvider(
    req: Request,
    url: URL,
    providerId: string,
    action: string,
  ): Promise<Response> {
    const provider = this.providers.get(providerId)
    if (!provider) return json(404, { error: `provider desconocido "${providerId}"` })
    if (req.method === 'GET' && action === 'capacity') {
      return json(200, this.capacity(provider, hintsFromQuery(url.searchParams)))
    }
    if (req.method === 'POST' && action === 'runs') return this.open(provider, req)
    return NOT_FOUND()
  }

  private list(): Response {
    return json(200, {
      providers: [...this.providers.values()].map((provider) => ({
        id: provider.id,
        maxConcurrent: provider.maxConcurrent ?? null,
        running: this.running(provider.id),
      })),
    })
  }

  private capacity(provider: Provider, hints: AdmissionHints): CapacityResponse {
    const max = provider.maxConcurrent
    const running = this.running(provider.id)
    if (max !== undefined && running >= max) {
      return this.busy(`${provider.id} al tope (${running}/${max})`)
    }
    const admission = this.options.admit?.({ providerId: provider.id, hints })
    if (admission && !admission.accept) {
      return this.busy(admission.reason, admission.retryAfterMs)
    }
    return { accepting: true }
  }

  private async open(provider: Provider, req: Request): Promise<Response> {
    const request = await body(req, RunRequest)
    // La sonda es consultiva: entre ella y este POST otro runner pudo tomar el último lugar.
    let verdict = this.capacity(provider, request.hints)
    if (verdict.accepting && provider.canAccept) {
      const admission = await provider.canAccept({
        agentId: request.agentId,
        ctx: {
          event: toDomainEvent(request.context.event),
          steps: {},
          bus: new EventBus(),
          pipelineId: request.context.pipelineId,
        },
      })
      if (!admission.accept) verdict = this.busy(admission.reason, admission.retryAfterMs)
    }
    if (!verdict.accepting) {
      const seconds = Math.ceil((verdict.retryAfterMs ?? 0) / 1000)
      return json(503, verdict, { 'retry-after': String(seconds) })
    }
    const run = new HostedRun(provider.id, request)
    this.runs.set(run.id, run)
    run.start(provider)
    this.log.info(`corrida ${run.id}: ${request.agentId} sobre ${provider.id}`)
    return json(202, { runId: run.id })
  }

  private async sync(id: string, req: Request): Promise<Response> {
    const run = this.runs.get(id)
    if (!run) return json(404, { error: `corrida desconocida "${id}"` })
    const request = await body(req, SyncRequest)
    return json(200, { events: await run.sync(request) })
  }

  /** El runner ya tiene el resultado, o dejó de esperarlo: se corta (si sigue) y se olvida. */
  private forget(id: string): Response {
    const run = this.runs.get(id)
    if (run) {
      run.cancel('el runner canceló la corrida')
      this.runs.delete(id)
    }
    return new Response(null, { status: 204 })
  }

  private busy(reason: string, retryAfterMs?: number): CapacityResponse {
    return {
      accepting: false,
      reason,
      retryAfterMs: retryAfterMs ?? this.options.busyRetryMs ?? DEFAULT_BUSY_RETRY_MS,
    }
  }

  private authorize(req: Request): Response | undefined {
    if (!this.token) return json(500, { error: 'el host no tiene token configurado' })
    const header = req.headers.get('authorization') ?? ''
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7).trim() : '')
    const ok = given.length === this.token.length && timingSafeEqual(given, this.token)
    return ok ? undefined : json(401, { error: 'token inválido' })
  }
}

class BadRequest extends Error {}

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.output<T>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new BadRequest('body JSON inválido')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new BadRequest(z.prettifyError(parsed.error))
  return parsed.data
}

function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}
