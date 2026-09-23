import type { DomainEvent } from '../events/DomainEvent.js'
import type { EventBus } from '../events/EventBus.js'
import type { Pipeline } from '../pipeline/Pipeline.js'

/**
 * Tope de la cadena de derivación de eventos (EmitAction, AgentAction con
 * emitOn: 'exit'). Sin esto, un pipeline que se re-emite a sí mismo —directo,
 * o a través de un ciclo de N pipelines— no tiene fondo: cada evento derivado
 * vuelve a matchear el mismo pipeline y dispara otro. Equivalente a
 * EngineEvent.depth en v1.
 */
export const MAX_EVENT_DEPTH = 10

/**
 * Dueño del roster de Pipeline y de despacharlos contra cada evento del bus.
 * Equivalente a rule-engine-handler.ts + TaskDispatcher + SourceIssueManager
 * de v1, colapsados: acá no hay scan — todo entra como DomainEvent (lo que en
 * v1 produce el scan queda afuera de este esqueleto, es quien PUBLICA al bus).
 */
export class Engine {
  private readonly pipelines: Pipeline[] = []

  constructor(private readonly bus: EventBus) {}

  register(pipeline: Pipeline): void {
    throw new Error('not implemented — push + sort por position')
  }

  start(): void {
    throw new Error('not implemented — this.bus.subscribe("*", event => this.dispatch(event))')
  }

  /**
   * 1) ¿el evento le habla a un run en vuelo? `Execution.tryAppend` corta
   *    acá si sí — el mensaje se lo queda esa Execution, ninguna Pipeline se
   *    reevalúa para este evento (ver engine/Execution.ts).
   * 2) si no, matchea Pipelines desde cero y las corre: TODAS las no-exclusive
   *    matcheadas EN PARALELO (Promise.all — son pipelines independientes);
   *    si alguna matcheada es `exclusive`, en cambio corre SÓLO la de mayor
   *    prioridad (menor `position`) entre las exclusive, y ninguna otra.
   */
  async dispatch(event: DomainEvent): Promise<void> {
    throw new Error(
      'not implemented — if (event.depth >= MAX_EVENT_DEPTH) return (loguear y abandonar la cadena); ' +
        'const taskId = event.scope?.issueId; ' +
        'if (Execution.tryAppend(taskId, toMessage(event))) return; ' +
        'const project = event.scope?.projectId ? Project.resolve(event.scope.projectId) : undefined; ' +
        'const matched = this.pipelines.filter(r => r.matches(event, project)); ' +
        'const survived = []; for (r of matched) if (await r.matchesText(event)) survived.push(r); ' +
        'const exclusive = survived.filter(r => r.exclusive).sort(by position).at(0); ' +
        'const toRun = exclusive ? [exclusive] : survived.filter(r => !r.exclusive); ' +
        'resuelve task del event.scope; ' +
        'await Promise.all(toRun.map(r => r.execute({event, task, steps: {}, bus: this.bus})))',
    )
  }
}
