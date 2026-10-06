import type { Tool } from '@ia-flow/agent-engine'
import { endingOf, type RunEnding } from '@ia-flow/provider-shared'
import { createLogger } from '@ia-flow/telemetry'
import { type HostTask, InboxResponse, ToolResult } from './protocol.js'

const DEFAULT_TEXT_EVERY_MS = 1_000

export interface RunnerLinkOptions {
  task: HostTask
  /** La base del runner, sin `/v1`. */
  base: string
  fetchImpl?: typeof fetch
  /** Cada cuánto manda el texto acumulado. Default: 1 s. */
  textEveryMs?: number
}

/**
 * Una corrida vista desde el host: lo que el `ProviderRunContext` de su provider necesita del
 * runner, sobre las rutas de la corrida.
 *
 * - `tools`: las del engine, como proxies de `/tools` (corren allá, con su span).
 * - `inbox`: se le pide al runner recién cuando el provider la va a usar — como en el runner: lo
 *   que el agente no alcanzó a leer queda sin leer, y el engine lo re-despacha al cerrar.
 * - `saveConversation`: en orden, la última gana.
 * - `onText`: se junta y se manda cada `textEveryMs`.
 * - `ending`: cómo cerró el modelo su turno, si llamó una tool terminal — con eso el host decide
 *   qué hace con su worktree.
 */
export class RunnerLink {
  readonly log = createLogger('provider-remote.host')
  private readonly fetchImpl: typeof fetch
  private deltas: string[] = []
  private endingValue: RunEnding | undefined
  private saving: Promise<void> = Promise.resolve()
  private readonly timers: Array<ReturnType<typeof setInterval>> = []
  private stopped = false

  constructor(private readonly options: RunnerLinkOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  get ending(): RunEnding | undefined {
    return this.endingValue
  }

  /** Arranca lo que corre de fondo (el texto en vivo). */
  start(): void {
    this.every(this.options.textEveryMs ?? DEFAULT_TEXT_EVERY_MS, () => this.pushText())
  }

  /** Corta lo de fondo y manda lo que quedaba: la conversación y el texto. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.timers) clearInterval(timer)
    await this.pushText()
    await this.saving
  }

  tools(): Tool[] {
    return this.options.task.tools.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      ...(spec.terminal ? { terminal: true } : {}),
      ...(spec.failure ? { failure: true } : {}),
      handler: async (input: unknown) => {
        const { text, isError } = await this.callTool(spec.name, input)
        if (isError) throw new Error(text)
        if (spec.terminal) this.endingValue ??= endingOf(spec)
        return text
      },
    }))
  }

  /** Lo que llegó a la ejecución desde la última vez (y el runner lo da por leído). Si el runner no
   *  contesta, nada: lo que hubiera sigue allá sin leer, para la próxima o para re-despacharse. */
  async inbox(): Promise<string[]> {
    try {
      const res = await this.post(this.options.task.endpoints.inbox, {})
      return InboxResponse.parse(await res.json()).messages
    } catch (error) {
      this.log.warn(`no pude leer la bandeja: ${(error as Error).message}`)
      return []
    }
  }

  saveConversation(conversation: unknown): void {
    this.saving = this.saving
      .then(() => this.post(this.options.task.endpoints.conversation, { conversation }))
      .then(() => {})
      .catch((error) =>
        this.log.warn(`no pude guardar la conversación: ${(error as Error).message}`),
      )
  }

  onText(delta: string): void {
    this.deltas.push(delta)
  }

  private async callTool(name: string, input: unknown): Promise<ToolResult> {
    const res = await this.post(this.options.task.endpoints.tools, { name, input: input ?? {} })
    return ToolResult.parse(await res.json())
  }

  private async pushText(): Promise<void> {
    if (this.deltas.length === 0) return
    const deltas = this.deltas
    this.deltas = []
    try {
      await this.post(this.options.task.endpoints.text, { deltas })
    } catch {
      // El texto en vivo es para mirar: si no llega, la corrida sigue igual.
    }
  }

  private every(ms: number, tick: () => Promise<void>): void {
    let running = false
    const timer = setInterval(() => {
      if (running || this.stopped) return
      running = true
      void tick().finally(() => {
        running = false
      })
    }, ms)
    timer.unref?.()
    this.timers.push(timer)
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const res = await this.fetchImpl(`${this.options.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
    return res
  }
}
