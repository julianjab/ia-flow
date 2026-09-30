import { randomUUID } from 'node:crypto'
import {
  type DomainEvent,
  EventBus,
  type PipelineExecutionContext,
  type Provider,
  type ProviderRunContext,
  type ProviderRunOutput,
  type Tool,
} from '@ia-flow/agent-engine'
import { createLogger } from '@ia-flow/telemetry'
import type { RunEvent, RunRequest, SyncRequest, ToolResult } from './protocol.js'

type PendingCall = { resolve: (text: string) => void; reject: (error: Error) => void }
/** Un evento antes de numerarlo — `Omit` sobre la unión, rama por rama. */
type NewEvent = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, 'seq'> : never) : never

/**
 * Una corrida del lado del host: el `Provider` local corriendo con tools que son proxies — cada
 * llamada se vuelve un evento `tool_call` que el runner levanta en su próximo sync, y se resuelve
 * cuando vuelve el resultado. Lo que el runner no reconoció (`after`) se le reenvía; lo que el
 * runner reenvía (resultados, inbox) se aplica una sola vez.
 */
export class HostedRun {
  readonly id = randomUUID()
  readonly log = createLogger('provider-remote')
  private readonly events: RunEvent[] = []
  private seq = 0
  private readonly waiters = new Set<() => void>()
  private readonly pending = new Map<string, PendingCall>()
  private readonly inbox: string[] = []
  /** Cuántos mensajes del inbox del runner ya se recibieron (para descartar reenvíos). */
  private inboxReceived = 0
  private inflight = 0
  private lastContactAt = Date.now()
  private cancelled: string | undefined
  private endedAt: number | undefined

  constructor(
    readonly providerId: string,
    private readonly request: RunRequest,
  ) {}

  /** Arranca el provider local. No espera: el resultado sale como evento `done`/`failed`. */
  start(provider: Provider): void {
    provider.run(this.runContext()).then(
      (output) => this.end({ type: 'done', output: outputWire(output) }),
      (error: unknown) =>
        this.end({ type: 'failed', error: error instanceof Error ? error.message : String(error) }),
    )
  }

  get ended(): boolean {
    return this.endedAt !== undefined
  }

  /** Aplica lo que manda el runner y devuelve los eventos que todavía no reconoció — esperando
   *  hasta `waitMs` si no hay ninguno. */
  async sync(request: SyncRequest): Promise<RunEvent[]> {
    this.inflight++
    this.lastContactAt = Date.now()
    try {
      for (const result of request.results) this.settle(result)
      this.receiveInbox(request.inboxFrom, request.inbox)
      this.ack(request.after)
      if (!this.hasEventsAfter(request.after) && !this.ended && request.waitMs > 0) {
        await this.nextEvent(request.waitMs)
      }
      return this.events.filter((event) => event.seq > request.after)
    } finally {
      this.inflight--
      this.lastContactAt = Date.now()
    }
  }

  /** Corta la corrida: toda tool pendiente o futura falla con `reason`, así el provider local
   *  termina en vez de esperar un resultado que nadie va a mandar. */
  cancel(reason: string): void {
    if (this.cancelled || this.ended) return
    this.cancelled = reason
    for (const call of this.pending.values()) call.reject(new Error(reason))
    this.pending.clear()
  }

  /** El runner dejó de sincronizar: ni un sync en curso ni uno reciente. */
  isOrphaned(now: number, orphanAfterMs: number): boolean {
    return !this.ended && this.inflight === 0 && now - this.lastContactAt > orphanAfterMs
  }

  /** Terminó hace más de `retainMs` y el runner nunca vino a buscar el resultado. */
  isExpired(now: number, retainMs: number): boolean {
    return this.endedAt !== undefined && now - this.endedAt > retainMs
  }

  private runContext(): ProviderRunContext {
    const req = this.request
    return {
      agentId: req.agentId,
      prompt: req.prompt,
      systemPrompts: req.systemPrompts,
      variables: req.variables,
      providerConfig: req.providerConfig,
      mcpServers: req.mcpServers,
      tools: req.tools.map((spec) => this.proxy(spec)),
      ctx: pipelineContext(req.context),
      ...(req.inbox ? { inbox: () => this.inbox.splice(0) } : {}),
      ...(req.resume ? { resume: req.resume } : {}),
      ...(req.saveConversation
        ? { saveConversation: (conversation: unknown) => this.saveConversation(conversation) }
        : {}),
    }
  }

  /** Una tool cuyo handler corre en el runner. Un resultado con error vuelve como excepción: así
   *  el provider local lo trata igual que a una tool propia que tira. */
  private proxy(spec: RunRequest['tools'][number]): Tool {
    return {
      ...spec,
      handler: (input: unknown) => {
        if (this.cancelled) throw new Error(this.cancelled)
        const callId = randomUUID()
        const result = new Promise<string>((resolve, reject) => {
          this.pending.set(callId, { resolve, reject })
        })
        this.push({ type: 'tool_call', callId, name: spec.name, input: input ?? {} })
        return result
      },
    }
  }

  /** Sólo importa la última: una que el runner todavía no levantó se reemplaza. */
  private saveConversation(conversation: unknown): void {
    const stale = this.events.findIndex((event) => event.type === 'conversation')
    if (stale >= 0) this.events.splice(stale, 1)
    this.push({ type: 'conversation', conversation })
  }

  private settle(result: ToolResult): void {
    const call = this.pending.get(result.callId)
    // Un resultado reenviado (el sync anterior se cortó) ya no tiene a quién resolver.
    if (!call) return
    this.pending.delete(result.callId)
    if (result.isError) call.reject(new Error(result.text))
    else call.resolve(result.text)
  }

  private receiveInbox(from: number, messages: string[]): void {
    const fresh = messages.slice(Math.max(0, this.inboxReceived - from))
    this.inbox.push(...fresh)
    this.inboxReceived = Math.max(this.inboxReceived, from + messages.length)
  }

  private ack(after: number): void {
    while (this.events[0] && this.events[0].seq <= after) this.events.shift()
  }

  private hasEventsAfter(after: number): boolean {
    return this.events.some((event) => event.seq > after)
  }

  private end(event: NewEvent): void {
    if (this.ended) return
    this.endedAt = Date.now()
    if (this.pending.size > 0) this.cancel('la corrida terminó')
    this.push(event)
    if (event.type === 'failed') this.log.warn(`${this.request.agentId}: ${event.error}`)
  }

  private push(event: NewEvent): void {
    this.events.push({ ...event, seq: ++this.seq } as RunEvent)
    for (const wake of this.waiters) wake()
    this.waiters.clear()
  }

  private nextEvent(waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, waitMs)
      timer.unref?.()
      const waiters = this.waiters
      function done() {
        clearTimeout(timer)
        waiters.delete(done)
        resolve()
      }
      waiters.add(done)
    })
  }
}

/** El contexto que ve el provider local: el evento real (de él sale, p. ej., el worktree) y un
 *  bus propio — lo que el provider publique no vuelve al runner. */
function pipelineContext(wire: RunRequest['context']): PipelineExecutionContext {
  return {
    event: wire.event as DomainEvent,
    steps: {},
    bus: new EventBus(),
    pipelineId: wire.pipelineId,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
  }
}

function outputWire(output: ProviderRunOutput): ProviderRunOutput {
  return {
    outcome: output.outcome,
    ...(output.summary !== undefined ? { summary: output.summary } : {}),
    ...(output.structuredOutput ? { structuredOutput: output.structuredOutput } : {}),
    ...(output.conversation !== undefined ? { conversation: output.conversation } : {}),
  }
}
