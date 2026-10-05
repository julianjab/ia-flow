import { randomUUID } from 'node:crypto'
import { type Tool, WAIT_TOOL_NAME } from '@ia-flow/agent-engine'
import {
  type Context,
  createLogger,
  markError,
  type Span,
  SpanKind,
  startSpan,
  truncate,
} from '@ia-flow/telemetry'
import { context } from '@opentelemetry/api'
import { hookLogs } from './hookTaxonomy.js'
import type { TranscriptMessage } from './transcript/TranscriptAssembler.js'
import { TranscriptTail } from './transcript/TranscriptTail.js'

/** El nombre del servidor MCP de la corrida en el `--mcp-config`: sus tools le llegan al modelo
 *  como `mcp__ia-flow__<tool>`. */
export const MCP_SERVER_NAME = 'ia-flow'
export const mcpToolName = (tool: string) => `mcp__${MCP_SERVER_NAME}__${tool}`

/**
 * Cómo cerró el modelo su turno: `done` eligió una salida (`submit_*`), `paused` espera un evento
 * (`wait_for_event`: sigue en esta misma conversación y en este mismo directorio), `failed` lo
 * cerró como falla o cedió (`fail_turn`, `yield_turn`).
 */
export type RunEnding = 'done' | 'paused' | 'failed'

export function endingOf(tool: Pick<Tool, 'name' | 'failure'>): RunEnding {
  if (tool.name === WAIT_TOOL_NAME) return 'paused'
  return tool.failure ? 'failed' : 'done'
}

const SCOPE = '@ia-flow/provider-anthropic-cli'

/** Lo que devuelve un hook: el JSON que Claude Code lee de su stdout. */
export type HookOutput = Record<string, unknown>

export interface RunChannelOptions {
  agentId: string
  tools: Tool[]
  /** El inbox de la ejecución: lo que llegó desde la última vez, y lo saca. */
  inbox?: () => string[]
  /** El span del agente: de él cuelgan los de cada tool. */
  parent: Context
  /** Cuántas veces insistir en que cierre con `submit_*`. */
  maxStopNudges: number
  /** El texto del modelo, mensaje por mensaje, a medida que la transcripción lo registra. */
  onText?: (text: string) => void
  /** Cuándo arrancó la corrida: lo anterior de la transcripción (una sesión retomada) no se
   *  vuelve a emitir. */
  since?: Date
  /** Leer la transcripción de la sesión (`transcript_path` de los hooks). Default: sí. Una sesión
   *  en otra máquina (un host remoto) la escribe en SU disco: el path no es de éste. */
  transcript?: boolean
  /** Cada señal de vida de la sesión (una tool, un hook): quien la espera de lejos mide el
   *  silencio con esto. */
  onActivity?: () => void
}

/**
 * Una corrida vista desde el servidor local: sus tools (lo que sirve el MCP), su inbox (lo que
 * entregan los hooks) y cuándo terminó — el modelo llamó una tool terminal (`submit_*`,
 * `fail_turn`, `yield_turn`, `wait_for_event`) y devolvió OK. Se identifica por un token al azar:
 * varias corridas en paralelo, cada una sólo ve lo suyo.
 */
export class RunChannel {
  readonly log = createLogger('provider-anthropic-cli')
  readonly token = randomUUID()
  readonly done: Promise<void>
  private finishDone!: () => void
  private finishedFlag = false
  private endingValue: RunEnding | undefined
  private nudges = 0
  private readonly spans = new Map<string, Span>()
  private readonly transcript: TranscriptTail

  constructor(private readonly options: RunChannelOptions) {
    this.done = new Promise((resolve) => {
      this.finishDone = resolve
    })
    this.transcript = new TranscriptTail({
      onMessage: (message) => this.recordMessage(message),
      ...(options.since ? { since: options.since } : {}),
    })
  }

  get finished(): boolean {
    return this.finishedFlag
  }

  /** Cómo cerró el turno, si lo cerró (la primera tool terminal que llamó). */
  get ending(): RunEnding | undefined {
    return this.endingValue
  }

  /** Lo que lista el MCP (`tools/list`). */
  listTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return this.options.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }))
  }

  /** `tools/call`: corre la tool en el runner (con el `ctx` de la corrida que ya capturó). Un
   *  error vuelve como resultado con `isError`, para que el modelo lo lea y se corrija. */
  async call(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    this.options.onActivity?.()
    const tool = this.options.tools.find((candidate) => candidate.name === name)
    if (!tool) return { text: `No existe la tool "${name}"`, isError: true }
    const span = startSpan(
      `execute_tool ${name}`,
      {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': name,
        'ia.tool.input': truncate(args),
      },
      { parent: this.options.parent, scope: SCOPE },
    )
    try {
      const text = await tool.handler(args ?? {})
      span.setAttribute('ia.tool.result', truncate(text))
      if (tool.terminal) {
        this.endingValue ??= endingOf(tool)
        this.finish()
      }
      return { text, isError: false }
    } catch (error) {
      markError(span, error)
      return { text: (error as Error).message, isError: true }
    } finally {
      span.end()
    }
  }

  /** Un hook de Claude Code: traza sus tools nativas, entrega el inbox y no lo deja terminar sin
   *  cerrar el turno. */
  hook(event: string, input: Record<string, unknown>): HookOutput {
    this.options.onActivity?.()
    this.logHook(event, input)
    this.readTranscript(event, input)
    switch (event) {
      case 'PreToolUse':
        this.startNative(input)
        return {}
      case 'PostToolUse':
        this.endNative(input)
        return this.deliver('PostToolUse')
      case 'Stop':
        return this.onStop()
      default:
        return {}
    }
  }

  /** Cada hook deja su log (ver `hookTaxonomy`), dentro de la traza del agente: sale con su
   *  `traceId` y los atributos heredados (`ia.execution.id`, el scope del evento). */
  private logHook(event: string, input: Record<string, unknown>): void {
    context.with(this.options.parent, () => {
      for (const { level, message, attributes } of hookLogs(event, input)) {
        this.log[level](message, { 'ia.agent.id': this.options.agentId, ...attributes })
      }
    })
  }

  /** Lo nuevo de la transcripción, sin esperar: el hook contesta ya. En `Stop` el modelo terminó
   *  de escribir, así que el último mensaje también sale. */
  private readTranscript(event: string, input: Record<string, unknown>): void {
    const path = input.transcript_path
    if (this.options.transcript === false || typeof path !== 'string' || !path) return
    void this.transcript.read(path, { flush: event === 'Stop' })
  }

  /** Un request al modelo, como un span GenAI colgado del agente (como `chat <model>` del
   *  provider de la API), y su texto a `onText`. Lo llama la lectura de la transcripción, o —si la
   *  sesión corre en otra máquina— quien se la reenvía. */
  recordMessage(message: TranscriptMessage): void {
    const model = message.model ?? 'unknown'
    const span = startSpan(
      `chat ${model}`,
      {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'anthropic',
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.response.id': message.id,
        'gen_ai.usage.input_tokens': message.usage.inputTokens,
        'gen_ai.usage.output_tokens': message.usage.outputTokens,
        'gen_ai.usage.cache_read_input_tokens': message.usage.cacheReadTokens,
        'gen_ai.usage.cache_creation_input_tokens': message.usage.cacheCreationTokens,
        ...(message.sidechain ? { 'ia.transcript.sidechain': true } : {}),
      },
      { parent: this.options.parent, scope: SCOPE, kind: SpanKind.CLIENT },
    )
    for (const text of message.texts) span.addEvent('assistant.text', { 'ia.text': truncate(text) })
    span.end()
    if (message.sidechain || !this.options.onText) return
    for (const text of message.texts) this.options.onText(text)
  }

  private finish(): void {
    if (this.finishedFlag) return
    this.finishedFlag = true
    this.finishDone()
  }

  /** Lo que llegó al inbox, como contexto extra del próximo paso del modelo. */
  private deliver(hookEventName: string): HookOutput {
    const messages = this.options.inbox?.() ?? []
    if (messages.length === 0) return {}
    return {
      hookSpecificOutput: { hookEventName, additionalContext: received(messages) },
    }
  }

  /** El modelo quiere terminar: si no cerró el turno se le insiste (unas veces), y si llegó algo
   *  mientras tanto se lo entrega antes de dejarlo ir. */
  private onStop(): HookOutput {
    const messages = this.options.inbox?.() ?? []
    const reasons = messages.length > 0 ? [received(messages)] : []
    if (!this.finishedFlag && this.nudges < this.options.maxStopNudges) {
      this.nudges++
      reasons.push(this.nudge())
    }
    return reasons.length > 0 ? { decision: 'block', reason: reasons.join('\n\n') } : {}
  }

  private nudge(): string {
    const exits = this.options.tools
      .filter((tool) => tool.terminal && !tool.failure)
      .map((tool) => mcpToolName(tool.name))
    return `Todavía no cerraste tu turno. Para terminar llamá a una de estas tools: ${exits.join(', ')} — o ${mcpToolName('fail_turn')} si no podés completar la tarea.`
  }

  /** Las tools nativas del CLI (`Bash`, `Edit`, `Task`, …) — las del MCP se trazan en `call`. */
  private startNative(input: Record<string, unknown>): void {
    const name = String(input.tool_name ?? '')
    const id = String(input.tool_use_id ?? '')
    if (!name || !id || name.startsWith(`mcp__${MCP_SERVER_NAME}__`)) return
    this.spans.set(
      id,
      startSpan(
        `execute_tool ${name}`,
        {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': name,
          'gen_ai.tool.call.id': id,
          'ia.tool.input': truncate(input.tool_input),
        },
        { parent: this.options.parent, scope: SCOPE },
      ),
    )
  }

  private endNative(input: Record<string, unknown>): void {
    const id = String(input.tool_use_id ?? '')
    const span = this.spans.get(id)
    if (!span) return
    this.spans.delete(id)
    span.setAttribute('ia.tool.result', truncate(input.tool_response))
    span.end()
  }

  /** Cierra los spans que quedaron abiertos (la sesión murió a mitad de una tool) y termina de
   *  leer la transcripción: el último mensaje sale aunque no haya llegado un `Stop`. */
  async close(): Promise<void> {
    for (const span of this.spans.values()) span.end()
    this.spans.clear()
    await this.transcript.finish()
  }
}

function received(messages: string[]): string {
  return messages.map((text) => `[Mensaje recibido mientras trabajabas]\n${text}`).join('\n\n')
}
