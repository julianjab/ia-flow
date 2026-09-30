import type {
  Admission,
  PipelineExecutionContext,
  Provider,
  ProviderRunContext,
  ProviderRunOutput,
} from '@ia-flow/agent-engine'
import { createLogger } from '@ia-flow/telemetry'
import type { RemoteProviderConfig } from './config.js'
import {
  type AdmissionHints,
  CapacityResponse,
  hintsToQuery,
  PROTOCOL_PREFIX,
  RunAccepted,
  type RunRequest,
} from './protocol.js'
import { RemoteRun } from './RemoteRun.js'

/** Los tiempos del cliente. Todos tienen default; los tests los achican. */
export interface RemoteTiming {
  /** La sonda de capacidad corre en el camino caliente de cada corrida: corta a propósito. */
  probeTimeoutMs: number
  /** Cuánto se espera que el host ACEPTE la corrida (no que la termine). */
  acceptTimeoutMs: number
  /** Cuánto retiene el host cada sync esperando algo nuevo. */
  longPollMs: number
  /** Lo que se le suma a un request para darlo por colgado. */
  requestSlackMs: number
  /** Cuánto esperar antes de reintentar un sync fallido. */
  retryDelayMs: number
  /** Cuándo volver a preguntarle a un host que no contesta. */
  unreachableRetryMs: number
  /** Cuándo volver a preguntarle a un host al tope, si no dice cuándo. */
  busyRetryMs: number
}

const DEFAULT_TIMING: RemoteTiming = {
  probeTimeoutMs: 2_000,
  acceptTimeoutMs: 30_000,
  longPollMs: 15_000,
  requestSlackMs: 10_000,
  retryDelayMs: 2_000,
  unreachableRetryMs: 30_000,
  busyRetryMs: 30_000,
}
const DEFAULT_MAX_SILENCE_SECONDS = 120

export interface RemoteProviderOptions extends RemoteProviderConfig {
  /** El id con el que lo nombran los agentes. */
  id: string
  /** Pistas propias del runner para las reglas del host (ej. `repo`), además de `agentId`,
   *  `eventType` y el `scope` del evento. */
  hints?: (ctx: PipelineExecutionContext) => AdmissionHints
  fetchImpl?: typeof fetch
  timing?: Partial<RemoteTiming>
}

/**
 * Un `Provider` que corre en otra máquina — un `RemoteProviderHost` que expone ahí un provider
 * local (Anthropic, el CLI `claude`). Para el engine es un provider más: `canAccept` le pregunta
 * al host si puede, y `run` abre la corrida allá y la sigue hasta que termina. Las tools del agente
 * no viajan: corren acá, cuando el modelo de allá las llama (ver `RemoteRun`).
 */
export class RemoteProvider implements Provider {
  readonly id: string
  readonly maxConcurrent?: number
  readonly log = createLogger('provider-remote')
  private readonly base: string
  private readonly remoteId: string
  private readonly timing: RemoteTiming
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: RemoteProviderOptions) {
    this.id = options.id
    if (options.maxConcurrent !== undefined) this.maxConcurrent = options.maxConcurrent
    this.base = options.url.replace(/\/+$/, '')
    this.remoteId = options.provider ?? options.id
    this.timing = { ...DEFAULT_TIMING, ...options.timing }
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Le pregunta al host: corre en otro proceso, puede servir a varios runners y sabe cosas que
   * este no (su carga, sus reglas). Un "no" explícito demora la corrida; un host que no contesta,
   * también — mandarle trabajo a uno caído la haría fallar de verdad. Cualquier otra respuesta
   * (un 404 de un host viejo, un body raro) admite: la corrida sigue y, si algo está mal, falla
   * en `run` diciendo qué.
   */
  async canAccept(request: { agentId: string; ctx: PipelineExecutionContext }): Promise<Admission> {
    const hints = this.hintsFor(request.agentId, request.ctx)
    const url = `${this.providerUrl()}/capacity?${hintsToQuery(hints)}`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timing.probeTimeoutMs),
      })
    } catch (error) {
      return {
        accept: false,
        reason: `host ${this.base} inalcanzable: ${(error as Error).message}`,
        retryAfterMs: this.timing.unreachableRetryMs,
      }
    }
    if (!res.ok) return { accept: true }
    const parsed = CapacityResponse.safeParse(await res.json().catch(() => undefined))
    if (!parsed.success || parsed.data.accepting) return { accept: true }
    return {
      accept: false,
      reason: `host ${this.base}: ${parsed.data.reason ?? 'no está tomando trabajo'}`,
      retryAfterMs: parsed.data.retryAfterMs ?? this.timing.busyRetryMs,
    }
  }

  async run(ctx: ProviderRunContext): Promise<ProviderRunOutput> {
    const runId = await this.open(this.requestOf(ctx))
    this.log.info(`${ctx.agentId}: corrida ${runId} en ${this.base} (${this.remoteId})`)
    const silence = this.options.maxSilenceSeconds ?? DEFAULT_MAX_SILENCE_SECONDS
    const minutes = this.options.runTimeoutMinutes
    return new RemoteRun({
      providerId: this.id,
      runUrl: `${this.base}${PROTOCOL_PREFIX}/runs/${encodeURIComponent(runId)}`,
      headers: this.headers(),
      fetchImpl: this.fetchImpl,
      ctx,
      longPollMs: this.timing.longPollMs,
      requestSlackMs: this.timing.requestSlackMs,
      retryDelayMs: this.timing.retryDelayMs,
      maxSilenceMs: silence === 0 ? Number.POSITIVE_INFINITY : silence * 1000,
      deadline: minutes ? Date.now() + minutes * 60_000 : Number.POSITIVE_INFINITY,
    }).result()
  }

  /**
   * Abre la corrida. Un 503 es la contracara de `canAccept`: la sonda admitió y otro runner tomó
   * el último lugar en el medio (es consultiva, no reserva). No es un fallo — se espera lo que
   * pida el host y se vuelve a intentar.
   */
  private async open(request: RunRequest): Promise<string> {
    const body = JSON.stringify(request)
    while (true) {
      const res = await this.fetchImpl(`${this.providerUrl()}/runs`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timing.acceptTimeoutMs),
      })
      if (res.status === 202) return RunAccepted.parse(await res.json()).runId
      const text = await res.text().catch(() => '')
      if (res.status !== 503) {
        throw new Error(`${this.id}: ${this.base} respondió ${res.status} — ${text.slice(0, 500)}`)
      }
      const waitMs = retryAfterMs(res, text) ?? this.timing.busyRetryMs
      this.log.info(`${request.agentId}: ${this.base} al tope — reintenta en ${waitMs} ms`)
      await delay(waitMs)
    }
  }

  private requestOf(ctx: ProviderRunContext): RunRequest {
    const { event } = ctx.ctx
    return {
      agentId: ctx.agentId,
      prompt: ctx.prompt,
      systemPrompts: ctx.systemPrompts,
      variables: ctx.variables,
      providerConfig: ctx.providerConfig,
      mcpServers: ctx.mcpServers,
      tools: ctx.tools.map(({ name, description, inputSchema, terminal, failure }) => ({
        name,
        description,
        inputSchema,
        ...(terminal ? { terminal } : {}),
        ...(failure ? { failure } : {}),
      })),
      context: {
        event: {
          type: event.type,
          payload: event.payload,
          ...(event.scope ? { scope: event.scope } : {}),
          occurredAt: event.occurredAt,
          depth: event.depth,
          ...(event.executionId ? { executionId: event.executionId } : {}),
        },
        pipelineId: ctx.ctx.pipelineId,
        ...(ctx.ctx.sourceId ? { sourceId: ctx.ctx.sourceId } : {}),
        ...(ctx.ctx.execution ? { executionId: ctx.ctx.execution.id } : {}),
      },
      hints: this.hintsFor(ctx.agentId, ctx.ctx),
      inbox: ctx.inbox !== undefined,
      saveConversation: ctx.saveConversation !== undefined,
      ...(ctx.resume ? { resume: ctx.resume } : {}),
    }
  }

  private hintsFor(agentId: string, ctx: PipelineExecutionContext): AdmissionHints {
    const hints: AdmissionHints = { agentId: [agentId], eventType: [ctx.event.type] }
    for (const [key, value] of Object.entries(ctx.event.scope ?? {})) {
      if (typeof value === 'string' || typeof value === 'number') hints[key] = [String(value)]
    }
    return { ...hints, ...this.options.hints?.(ctx) }
  }

  private providerUrl(): string {
    return `${this.base}${PROTOCOL_PREFIX}/providers/${encodeURIComponent(this.remoteId)}`
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.token}` }
  }
}

/** El `retryAfterMs` del body (en ms, el del host) o, si no viene, `Retry-After` (RFC 9110, en
 *  segundos: lo que manda un proxy en el medio). */
function retryAfterMs(res: Response, body: string): number | undefined {
  try {
    const parsed = CapacityResponse.partial().parse(JSON.parse(body))
    if (parsed.retryAfterMs !== undefined) return parsed.retryAfterMs
  } catch {
    // No es un body del host.
  }
  const seconds = Number.parseInt(res.headers.get('retry-after') ?? '', 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
