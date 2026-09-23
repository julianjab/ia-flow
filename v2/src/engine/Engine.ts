import type { ProjectRegistry } from '../domain/ProjectRegistry.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { EventBus } from '../events/EventBus.js'
import type { ActionRegistry } from '../rules/ActionRegistry.js'
import type { Rule } from '../rules/Rule.js'
import type { AgentRegistry } from './AgentRegistry.js'

/**
 * Tope de la cadena de derivación de eventos (EmitAction, AgentAction con
 * emitOn: 'exit'). Sin esto, una regla que se re-emite a sí misma —directo,
 * o a través de un ciclo de N reglas— no tiene fondo: cada evento derivado
 * vuelve a matchear la misma regla y dispara otro. Equivalente a
 * EngineEvent.depth en v1.
 */
export const MAX_EVENT_DEPTH = 10

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
    private readonly projects: ProjectRegistry,
  ) {}

  register(rule: Rule): void {
    throw new Error('not implemented — push + sort por position')
  }

  start(): void {
    throw new Error('not implemented — this.bus.subscribe("*", event => this.dispatch(event))')
  }

  /**
   * 1) ¿el evento le habla a un run en vuelo? `Execution.tryAppend` corta
   *    acá si sí — el mensaje se lo queda esa Execution, ninguna Rule se
   *    reevalúa para este evento (ver engine/Execution.ts).
   * 2) si no, matchea Rules desde cero y las corre: TODAS las no-exclusive
   *    matcheadas EN PARALELO (Promise.all — son pipelines independientes);
   *    si alguna matcheada es `exclusive`, en cambio corre SÓLO la de mayor
   *    prioridad (menor `position`) entre las exclusive, y ninguna otra.
   */
  async dispatch(event: DomainEvent): Promise<void> {
    throw new Error(
      'not implemented — if (event.depth >= MAX_EVENT_DEPTH) return (loguear y abandonar la cadena); ' +
        'const taskId = event.scope?.issueId; ' +
        'if (Execution.tryAppend(taskId, toMessage(event))) return; ' +
        'const project = event.scope?.projectId ? this.projects.resolve(event.scope.projectId) : undefined; ' +
        'const matched = this.rules.filter(r => r.matches(event, project)); ' +
        'const survived = []; for (r of matched) if (await r.matchesText(event)) survived.push(r); ' +
        'const exclusive = survived.filter(r => r.exclusive).sort(by position).at(0); ' +
        'const toRun = exclusive ? [exclusive] : survived.filter(r => !r.exclusive); ' +
        'resuelve task del event.scope; ' +
        'await Promise.all(toRun.map(r => r.execute({event, task, steps: {}, agents: this.agents, ' +
        'actions: this.actions, bus: this.bus})))',
    )
  }
}
