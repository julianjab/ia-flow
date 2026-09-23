import type { DomainEvent } from '../events/DomainEvent.js'
import type { Rule } from '../rules/Rule.js'

export interface StepContext {
  readonly event: DomainEvent
  readonly rule: Rule
  readonly stepIndex: number
  /** Outputs de los steps anteriores en la misma cadena, en orden. */
  readonly previousOutputs: readonly unknown[]
}

/** Un elemento del `do` de una Rule. Agent y Action son las dos implementaciones;
 *  la cadena de una Rule es Step[] heterogéneo — cada uno recibe el output del
 *  anterior (o el payload del evento si es el primero) como su input. */
export abstract class Step<TIn = unknown, TOut = unknown> {
  abstract readonly kind: string
  abstract readonly name: string

  abstract run(input: TIn, ctx: StepContext): Promise<TOut>
}
