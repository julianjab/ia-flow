import type { ResolvedRoutes } from '../routing/ExitRoutes.js'
import { submitSchemaFor } from '../routing/ExitRoutes.js'
import type { AgentRunResult } from './Agent.js'
import type { Tool } from './AgentDefinition.js'
import { FailTool } from './FailTool.js'
import type { ProviderRunOutput } from './Provider.js'
import { type Submission, SubmitTool } from './SubmitTool.js'
import { type AgentWaits, type Waiting, WaitTool } from './WaitTool.js'
import { YieldTool } from './YieldTool.js'

/** Outcomes que NO aplican ninguna salida — el run se cortó desde afuera, no es un resultado
 *  del agente. Igual a `NO_TRANSITION_OUTCOMES` de ia-flow. */
export const NO_TRANSITION_OUTCOMES = new Set(['cancelled', 'truncated'])

/**
 * Cómo termina el turno de un agente: el modelo recibe una tool `submit_<salida>` por cada salida
 * resuelta y `fail_turn`, llama a UNA, y al terminar el provider esto dice qué eligió
 * (`AgentRunResult`) — o por qué el turno falló. Uno por corrida.
 *
 * Dentro de una ejecución (`interrupted` presente) recibe además `yield_turn`, para ceder el turno
 * si lo interrumpen: no elige salida, sólo cuenta en qué quedó (`AgentRunResult.progress`). Y, si
 * el agente declara `waits`, `wait_for_event`: pausa el turno hasta un evento
 * (`AgentRunResult.waiting`).
 */
export class TurnProtocol {
  readonly tools: Tool[]
  private submission: Submission | undefined
  private failure: string | undefined
  private yielded: string | undefined
  private waiting: Waiting | undefined

  constructor(
    private readonly agentId: string,
    private readonly routes: ResolvedRoutes,
    interrupted?: () => boolean,
    /** Qué puede esperar (`wait_for_event`) — sólo dentro de una ejecución. */
    waits?: AgentWaits,
  ) {
    this.tools = [
      ...routes.exits.map(
        (exit) =>
          new SubmitTool(agentId, exit, (submission) => {
            this.assertOpen()
            this.submission = submission
          }),
      ),
      new FailTool((reason) => {
        this.assertOpen()
        this.failure = reason
      }),
      ...(interrupted
        ? [
            new YieldTool(interrupted, (progress) => {
              this.assertOpen()
              this.yielded = progress
            }),
          ]
        : []),
      ...(interrupted && waits
        ? [
            new WaitTool(waits, (waiting) => {
              this.assertOpen()
              this.waiting = waiting
            }),
          ]
        : []),
    ]
  }

  /** Lo que eligió el modelo, visto el resultado del provider. Tira si el turno falló. */
  resolve(output: ProviderRunOutput): AgentRunResult {
    if (this.yielded !== undefined) return { output, progress: this.yielded }
    if (this.waiting !== undefined) return { output, waiting: this.waiting }
    if (NO_TRANSITION_OUTCOMES.has(output.outcome)) return { output }
    if (this.failure !== undefined) {
      throw new Error(`Agent(${this.agentId}): el agente declaró que falló: ${this.failure}`)
    }
    if (output.outcome === 'error') {
      throw new Error(
        `Agent(${this.agentId}): el provider reportó error${output.summary ? `: ${output.summary}` : ''}`,
      )
    }
    const submission = this.submission ?? this.fallback(output)
    return { output, exit: submission.exit, payload: submission.payload }
  }

  /** Un provider sin tools (un CLI, un modelo sin tool use) no puede llamar `submit_*`: se le
   *  acepta el outcome como nombre de salida, o la única salida, SI esa salida no pide datos. */
  private fallback(output: ProviderRunOutput): Submission {
    const { exits } = this.routes
    const byOutcome = exits.find((exit) => exit.name === output.outcome)
    const candidate = byOutcome ?? (exits.length === 1 ? exits[0] : undefined)
    if (candidate && submitSchemaFor(this.agentId, candidate).safeParse({}).success) {
      return { exit: candidate.name, payload: {} }
    }
    const names = exits.map((exit) => `submit_${exit.name}`).join(', ')
    throw new Error(
      `Agent(${this.agentId}): terminó sin elegir salida — tenía que llamar a ${names}`,
    )
  }

  private assertOpen(): void {
    if (this.submission) {
      throw new Error(
        `Ya elegiste la salida "${this.submission.exit}" — un turno termina con una sola.`,
      )
    }
    if (this.failure !== undefined) throw new Error('Ya declaraste que el turno falló.')
    if (this.yielded !== undefined) throw new Error('Ya cediste el turno.')
    if (this.waiting !== undefined) throw new Error('Ya pausaste tu turno esperando un evento.')
  }
}
