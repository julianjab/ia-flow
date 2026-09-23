import type { DomainEvent } from '../events/DomainEvent.js'
import type { EventBus } from '../events/EventBus.js'
import type { ActionRegistry } from '../rules/ActionRegistry.js'
import type { Rule } from '../rules/Rule.js'
import type { AgentRegistry } from './AgentRegistry.js'

/**
 * Dueño del roster de Rule y de despacharlas contra cada evento del bus.
 * Equivalente a rule-engine-handler.ts + TaskDispatcher + SourceIssueManager
 * de v1, colapsados: acá no hay scan — todo entra como DomainEvent (lo que en
 * v1 produce el scan queda afuera de este esqueleto, es quien PUBLICA al bus).
 */
export class Engine {
  private readonly rules: Rule[] = []

  constructor(
    private readonly bus: EventBus,
    private readonly agents: AgentRegistry,
    private readonly actions: ActionRegistry,
  ) {}

  register(rule: Rule): void {
    throw new Error('not implemented — push + sort por position')
  }

  start(): void {
    throw new Error('not implemented — this.bus.subscribe("*", event => this.dispatch(event))')
  }

  async dispatch(event: DomainEvent): Promise<void> {
    throw new Error(
      'not implemented — filtra this.rules por matches()+matchesText(), resuelve task del event.scope, ' +
        'ejecuta rule.execute({event, task, steps: {}, agents: this.agents, actions: this.actions, bus: this.bus}) ' +
        'en orden de position, corta en la primera exclusive',
    )
  }
}
