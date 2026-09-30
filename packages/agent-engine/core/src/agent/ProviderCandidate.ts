import { Conditional, type ConditionalProps } from '../condition/Conditional.js'
import type { PipelineExecutionContext } from '../pipeline/Runnable.js'

/**
 * Un provider candidato de un agente (`AgentDefinitionProps.providers`): con qué config corre en
 * él y cuándo es elegible — un `when`/`whenText` contra el evento, como el de un paso. El agente
 * usa el primero elegible que tenga lugar (ver `Agent`).
 */
export interface ProviderChoice extends ConditionalProps {
  /** Un provider registrado en el `ProviderRegistry`. */
  id: string
  /** Su `providerConfig` en este agente: cada provider tiene la suya. */
  config?: Record<string, unknown>
}

export class ProviderCandidate extends Conditional {
  readonly id: string
  readonly config: Record<string, unknown>

  constructor(choice: ProviderChoice) {
    super(choice)
    this.id = choice.id
    this.config = choice.config ?? {}
  }

  /** Por qué no es elegible para esta corrida, o `undefined` si lo es. Evalúa contra lo mismo que
   *  el `when` de un paso: el payload del evento y `steps`. */
  async ineligible(ctx: PipelineExecutionContext): Promise<string | undefined> {
    const payload = ctx.event.payload
    const base = typeof payload === 'object' && payload !== null ? payload : {}
    const subject = { ...base, steps: ctx.steps }
    return (
      this.explainConditions(subject) ??
      (await this.explainText(subject, ctx.classifier, ctx.event))
    )
  }
}
