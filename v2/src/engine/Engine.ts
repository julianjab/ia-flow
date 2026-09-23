import type { DomainEvent } from '../events/DomainEvent.js'
import type { EventBus } from '../events/EventBus.js'
import type { Rule } from '../rules/Rule.js'

/**
 * Dueño del roster de Rules y de despacharlas contra cada evento del bus.
 * Equivalente a rule-engine-handler.ts + TaskDispatcher + SourceIssueManager
 * de v1, colapsados: acá no hay scan — todo entra como DomainEvent.
 */
export class Engine {
  private readonly rules: Rule[] = []

  constructor(private readonly bus: EventBus) {}

  register(rule: Rule): void {
    throw new Error('not implemented — push + sort por position')
  }

  start(): void {
    throw new Error('not implemented — this.bus.subscribe("*", event => this.dispatch(event))')
  }

  async dispatch(event: DomainEvent): Promise<void> {
    throw new Error(
      'not implemented — filtra rules por matches()+matchesText(), ejecuta en orden, corta en la primera exclusive',
    )
  }
}
