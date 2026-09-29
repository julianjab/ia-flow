import { randomUUID } from 'node:crypto'
import type { Tool } from '@ia-flow/agent-engine'
import {
  type Context,
  createLogger,
  markError,
  type Span,
  startSpan,
  truncate,
} from '@ia-flow/telemetry'

/** El nombre del servidor MCP de la corrida en el `--mcp-config`: sus tools le llegan al modelo
 *  como `mcp__ia-flow__<tool>`. */
export const MCP_SERVER_NAME = 'ia-flow'
export const mcpToolName = (tool: string) => `mcp__${MCP_SERVER_NAME}__${tool}`

const SCOPE = '@ia-flow/provider-claude-cli'

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
}

/**
 * Una corrida vista desde el servidor local: sus tools (lo que sirve el MCP), su inbox (lo que
 * entregan los hooks) y cuándo terminó — el modelo llamó una tool terminal (`submit_*`,
 * `fail_turn`, `yield_turn`, `wait_for_event`) y devolvió OK. Se identifica por un token al azar:
 * varias corridas en paralelo, cada una sólo ve lo suyo.
 */
export class RunChannel {
  readonly log = createLogger('provider-claude-cli')
  readonly token = randomUUID()
  readonly done: Promise<void>
  private finishDone!: () => void
  private finishedFlag = false
  private nudges = 0
  private readonly spans = new Map<string, Span>()

  constructor(private readonly options: RunChannelOptions) {
    this.done = new Promise((resolve) => {
      this.finishDone = resolve
    })
  }

  get finished(): boolean {
    return this.finishedFlag
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
      if (tool.terminal) this.finish()
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
        this.log.debug(`${this.options.agentId}: hook ${event}`)
        return {}
    }
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
    this.log.info(`${this.options.agentId}: tool "${name}"`, {
      'gen_ai.tool.name': name,
      'ia.tool.input': truncate(input.tool_input, 500),
    })
  }

  private endNative(input: Record<string, unknown>): void {
    const id = String(input.tool_use_id ?? '')
    const span = this.spans.get(id)
    if (!span) return
    this.spans.delete(id)
    span.setAttribute('ia.tool.result', truncate(input.tool_response))
    span.end()
  }

  /** Cierra los spans que quedaron abiertos (la sesión murió a mitad de una tool). */
  close(): void {
    for (const span of this.spans.values()) span.end()
    this.spans.clear()
  }
}

function received(messages: string[]): string {
  return messages.map((text) => `[Mensaje recibido mientras trabajabas]\n${text}`).join('\n\n')
}
