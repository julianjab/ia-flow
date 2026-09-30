import type { ProviderRunContext, ProviderRunOutput } from '@ia-flow/agent-engine'
import {
  type Context,
  captureContext,
  createLogger,
  markError,
  startSpan,
  type TraceRecord,
  truncate,
} from '@ia-flow/telemetry'
import { type RunEvent, SyncResponse, type ToolResult } from './protocol.js'

const SCOPE = '@ia-flow/provider-remote'
/** El `origin` con el que el `traceRecorder` del host anota lo suyo si nadie le dice otro. */
const HOST_DEFAULT_ORIGIN = 'runner'

export interface RemoteRunOptions {
  /** El provider del runner, para los mensajes — y el `origin` de lo que llega del host. */
  providerId: string
  /** Los spans y logs del host (eventos `trace`). */
  onTrace?: (record: TraceRecord) => void
  /** `<base>/v1/runs/<runId>`. */
  runUrl: string
  headers: Record<string, string>
  fetchImpl: typeof fetch
  ctx: ProviderRunContext
  /** Cuánto retiene el host cada sync esperando un evento. */
  longPollMs: number
  /** Lo que se le suma a `longPollMs` para dar un sync por colgado. */
  requestSlackMs: number
  /** Cuánto esperar antes de reintentar un sync fallido. */
  retryDelayMs: number
  maxSilenceMs: number
  /** `Infinity`: sin tope. */
  deadline: number
}

/**
 * Una corrida abierta en el host, vista desde el runner: un loop de syncs (long-poll) que trae lo
 * que pasa allá —tools a correr, la conversación a guardar, el final— y lleva lo de acá: los
 * resultados de esas tools y lo que llegó al inbox.
 *
 * Las tools corren ACÁ, con el `ctx` de la corrida: sus efectos (elegir la salida, escribir en
 * GitHub) son del runner. Corren sin bloquear el loop —una tool larga no deja al host sin noticias
 * y lo hace creer huérfano— y cuando una termina, el sync en espera se corta para mandar el
 * resultado ya.
 *
 * Lo que se manda se reenvía hasta que un sync vuelve bien: el host descarta lo repetido.
 */
export class RemoteRun {
  readonly log = createLogger('provider-remote')
  private after = 0
  private readonly results: ToolResult[] = []
  private readonly inbox: string[] = []
  /** Cuántos mensajes del inbox ya confirmó el host. */
  private inboxAcked = 0
  private readonly started = new Set<string>()
  private wake: AbortController | undefined
  private readonly parent: Context = captureContext()

  constructor(private readonly options: RemoteRunOptions) {}

  async result(): Promise<ProviderRunOutput> {
    let silentSince: number | undefined
    while (true) {
      if (Date.now() > this.options.deadline) {
        await this.cancel()
        throw this.error('la corrida superó su tope de tiempo')
      }
      const sent = this.outgoing()
      const reply = await this.sync(sent)
      if (reply.kind === 'woken') continue
      if (reply.kind === 'failed') {
        silentSince ??= Date.now()
        // Un corte de red no es una corrida fallida: se insiste mientras el host pueda volver.
        if (Date.now() - silentSince >= this.options.maxSilenceMs) {
          await this.cancel()
          throw this.error(`el host dejó de responder — ${reply.error}`)
        }
        await delay(this.options.retryDelayMs)
        continue
      }
      silentSince = undefined
      this.acknowledge(sent)
      const end = this.apply(reply.events)
      if (end) {
        // Terminó: el host ya puede olvidarla.
        await this.cancel()
        if ('error' in end) throw this.error(end.error)
        return end.output
      }
    }
  }

  /** Lo que va en el próximo sync: todo lo que el host no confirmó todavía. */
  private outgoing() {
    this.inbox.push(...(this.options.ctx.inbox?.() ?? []))
    return {
      after: this.after,
      results: [...this.results],
      inbox: [...this.inbox],
      inboxFrom: this.inboxAcked,
    }
  }

  private acknowledge(sent: { results: ToolResult[]; inbox: string[] }): void {
    this.results.splice(0, sent.results.length)
    this.inbox.splice(0, sent.inbox.length)
    this.inboxAcked += sent.inbox.length
  }

  private async sync(
    sent: ReturnType<RemoteRun['outgoing']>,
  ): Promise<
    { kind: 'events'; events: RunEvent[] } | { kind: 'woken' } | { kind: 'failed'; error: string }
  > {
    const { longPollMs, requestSlackMs } = this.options
    const wake = new AbortController()
    this.wake = wake
    try {
      const res = await this.options.fetchImpl(`${this.options.runUrl}/sync`, {
        method: 'POST',
        headers: { ...this.options.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ ...sent, waitMs: longPollMs }),
        signal: AbortSignal.any([wake.signal, AbortSignal.timeout(longPollMs + requestSlackMs)]),
      })
      // El host no la conoce: reinició (y la corrida murió con él) o ya la olvidó. No hay nada que
      // esperar, y decirlo es mejor que sondear para siempre.
      if (res.status === 404) throw this.error('el host perdió la corrida (¿reinició?)')
      if (res.status === 401) throw this.error('el host rechazó el token')
      if (!res.ok) return { kind: 'failed', error: `status ${res.status}` }
      return { kind: 'events', events: SyncResponse.parse(await res.json()).events }
    } catch (error) {
      if (wake.signal.aborted) return { kind: 'woken' }
      if (error instanceof RemoteRunError) throw error
      return { kind: 'failed', error: (error as Error).message }
    } finally {
      this.wake = undefined
    }
  }

  /** Procesa los eventos en orden; devuelve cómo terminó, si terminó. */
  private apply(events: RunEvent[]): { output: ProviderRunOutput } | { error: string } | undefined {
    for (const event of events) {
      this.after = Math.max(this.after, event.seq)
      switch (event.type) {
        case 'tool_call':
          if (!this.started.has(event.callId)) {
            this.started.add(event.callId)
            void this.execute(event)
          }
          break
        case 'conversation':
          this.options.ctx.saveConversation?.(event.conversation)
          break
        case 'done':
          return { output: event.output }
        case 'failed':
          return { error: event.error }
        case 'trace':
          this.observe(() =>
            this.options.onTrace?.(
              event.record.origin === HOST_DEFAULT_ORIGIN
                ? { ...event.record, origin: this.options.providerId }
                : event.record,
            ),
          )
          break
        case 'text':
          this.observe(() => this.options.ctx.onText?.(event.delta))
          break
      }
    }
    return undefined
  }

  /** Corre la tool en el runner. Un error vuelve como resultado, para que el modelo lo lea. */
  private async execute(call: Extract<RunEvent, { type: 'tool_call' }>): Promise<void> {
    const tool = this.options.ctx.tools.find((candidate) => candidate.name === call.name)
    const span = startSpan(
      `execute_tool ${call.name}`,
      {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': call.name,
        'gen_ai.tool.call.id': call.callId,
        'ia.tool.input': truncate(call.input),
      },
      { parent: this.parent, scope: SCOPE },
    )
    let result: ToolResult
    try {
      if (!tool) throw new Error(`No existe la tool "${call.name}"`)
      const text = String(await tool.handler(call.input ?? {}))
      span.setAttribute('ia.tool.result', truncate(text))
      result = { callId: call.callId, text, isError: false }
    } catch (error) {
      markError(span, error)
      result = { callId: call.callId, text: (error as Error).message, isError: true }
    } finally {
      span.end()
    }
    this.results.push(result)
    this.wake?.abort()
  }

  /** Quien observa no puede cortar la corrida. */
  private observe(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      this.log.debug(`observador de la corrida: ${(error as Error).message}`)
    }
  }

  /** Le avisa al host que la suelte (terminó, o dejamos de esperarla). Best-effort. */
  private async cancel(): Promise<void> {
    await this.options
      .fetchImpl(this.options.runUrl, {
        method: 'DELETE',
        headers: this.options.headers,
        signal: AbortSignal.timeout(this.options.requestSlackMs),
      })
      .catch((error: unknown) => {
        this.log.warn(`no se pudo soltar la corrida en el host: ${(error as Error).message}`)
      })
  }

  private error(message: string): RemoteRunError {
    return new RemoteRunError(`${this.options.providerId}: ${message}`)
  }
}

class RemoteRunError extends Error {}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
