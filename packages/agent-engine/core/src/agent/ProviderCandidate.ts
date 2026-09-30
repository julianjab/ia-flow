import { Conditional, type ConditionalProps } from '../condition/Conditional.js'
import type { PipelineExecutionContext } from '../pipeline/Runnable.js'

/**
 * Un provider candidato de un agente (`AgentDefinitionProps.providers`): con qué config corre en
 * él y cuándo es elegible — un `when`/`whenText` contra el evento, como el de un paso. El agente
 * usa el primero elegible que tenga lugar (ver `Agent`).
 */
export interface ProviderChoice extends ConditionalProps {
  /** Un provider registrado en el `ProviderRegistry` — o un prefijo con `*` al final
   *  (`remote:*`): todos los registrados en ese momento que empiecen así, en el orden en que se
   *  registraron, cada uno con esta misma config y este `when`. */
  id: string
  /** Su `providerConfig` en este agente: cada provider tiene la suya. */
  config?: Record<string, unknown>
}

export class ProviderCandidate extends Conditional {
  readonly id: string
  readonly config: Record<string, unknown>

  constructor(private readonly choice: ProviderChoice) {
    super(choice)
    this.id = choice.id
    this.config = choice.config ?? {}
  }

  /** Un comodín (`remote:*`): se resuelve contra lo registrado al elegir. */
  get wildcard(): boolean {
    return this.id.endsWith('*')
  }

  /** Los ids registrados que cubre (el suyo, o los que empiezan con su prefijo). */
  covers(id: string): boolean {
    return this.wildcard ? id.startsWith(this.id.slice(0, -1)) : id === this.id
  }

  /** El mismo candidato para un provider concreto que cubre su comodín. */
  withId(id: string): ProviderCandidate {
    return new ProviderCandidate({ ...this.choice, id })
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
