import { randomUUID } from 'node:crypto'
import type { Tool } from '@ia-flow/agent-engine'
import { endingOf, type RunEnding } from '@ia-flow/provider-shared'
import { type Context, markError, startSpan, truncate } from '@ia-flow/telemetry'
import type { RunResult, ToolResult } from './protocol.js'

const SCOPE = '@ia-flow/provider-remote'

export interface RemoteRunOptions {
  agentId: string
  /** Las tools del engine: las que el host llama por `/tools` (las de workspace corren allá). */
  tools: Tool[]
  /** El span del agente: de él cuelgan los de cada tool. */
  parent: Context
  inbox?: () => string[] | Promise<string[]>
  saveConversation?: (conversation: unknown) => void
  onText?: (delta: string) => void
}

/**
 * Una corrida entregada a un host, vista desde el runner: las tools del engine que el modelo del
 * host llama por `/tools` (cada una con su span, colgado del agente), la bandeja, la conversación
 * en curso y el texto en vivo — lo que el `ProviderRunContext` le daría a un provider local — y el
 * resultado que el host devuelve por `/result`. Se identifica por un token al azar, que va en el
 * path: cada corrida sólo ve lo suyo.
 */
export class RemoteRun {
  readonly token = randomUUID()
  readonly result: Promise<RunResult>
  private settle!: (result: RunResult) => void
  private endingValue: RunEnding | undefined

  constructor(private readonly options: RemoteRunOptions) {
    this.result = new Promise((resolve) => {
      this.settle = resolve
    })
  }

  /** Cómo cerró el modelo su turno, si llamó una tool terminal. */
  get ending(): RunEnding | undefined {
    return this.endingValue
  }

  /** Una tool del engine. Un error vuelve como resultado con `isError`, para que el modelo lo lea
   *  y se corrija. */
  async call(name: string, input: unknown): Promise<ToolResult> {
    const tool = this.options.tools.find((candidate) => candidate.name === name)
    if (!tool) return { text: `No existe la tool "${name}"`, isError: true }
    const span = startSpan(
      `execute_tool ${name}`,
      {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': name,
        'ia.tool.input': truncate(input),
      },
      { parent: this.options.parent, scope: SCOPE },
    )
    try {
      const text = await tool.handler(input ?? {})
      span.setAttribute('ia.tool.result', truncate(text))
      if (tool.terminal) this.endingValue ??= endingOf(tool)
      return { text, isError: false }
    } catch (error) {
      markError(span, error)
      return { text: (error as Error).message, isError: true }
    } finally {
      span.end()
    }
  }

  /** Lo que llegó a la ejecución desde la última vez (y lo da por leído). */
  async inbox(): Promise<string[]> {
    return (await this.options.inbox?.()) ?? []
  }

  saveConversation(conversation: unknown): void {
    this.options.saveConversation?.(conversation)
  }

  text(deltas: string[]): void {
    const onText = this.options.onText
    if (onText) for (const delta of deltas) onText(delta)
  }

  /** El host terminó: lo que devolvió su provider, o que no pudo. Sólo cuenta el primero. */
  finish(result: RunResult): void {
    this.settle(result)
  }
}
