import type { DomainEvent } from '../events/DomainEvent.js'
import { Conditional, type ConditionalProps } from './Conditional.js'

export interface EventFilterProps extends ConditionalProps {
  /** Tipos de evento que pasan — al menos uno. */
  on: string[]
}

/**
 * Qué eventos pasan: un tipo de `on` y el `when` sobre su payload. El mismo par que filtra una
 * `Pipeline`, para quien necesita decir "estos eventos" sin ser una pipeline — ej. los que un
 * agente acepta que le inyecten mientras corre (`AgentDefinitionProps.injects`).
 */
export class EventFilter extends Conditional {
  readonly on: string[]

  constructor(props: EventFilterProps) {
    super(props)
    if (props.on.length === 0) throw new Error('EventFilter: `on` necesita al menos un tipo')
    this.on = props.on
  }

  matches(event: DomainEvent<any>): boolean {
    return this.on.includes(event.type) && this.matchesConditions(event.payload)
  }
}
