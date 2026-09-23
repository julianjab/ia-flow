import { Project } from '../domain/Project.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { EventBus } from '../events/EventBus.js'
import type { Pipeline } from '../pipeline/Pipeline.js'
import { Execution, type ExecutionMessage } from './Execution.js'

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
    this.pipelines.push(pipeline)
    this.pipelines.sort((a, b) => a.position - b.position)
  }

  start(): void {
    this.bus.subscribe('*', (event) => this.dispatch(event))
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
    if (event.depth >= MAX_EVENT_DEPTH) return

    const taskId = event.scope?.issueId
    const message: ExecutionMessage = {
      body: JSON.stringify(event.payload),
      origin: event.type,
      occurredAt: event.occurredAt,
      payload: event.payload,
    }
    if (Execution.tryAppend(taskId, message)) return

    const project = event.scope?.projectId ? Project.resolve(event.scope.projectId) : undefined
    const matched = this.pipelines.filter((p) => p.matches(event, project))
    const survived: Pipeline[] = []
    for (const p of matched) {
      if (await p.matchesText(event)) survived.push(p)
    }

    const exclusive = survived
      .filter((p) => p.exclusive)
      .sort((a, b) => a.position - b.position)[0]
    const toRun = exclusive ? [exclusive] : survived.filter((p) => !p.exclusive)
    if (toRun.length === 0) return

    await Promise.all(
      toRun.map((p) => p.execute({ event, steps: {}, bus: this.bus, pipelineId: p.id })),
    )
  }
}
