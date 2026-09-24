import type { ProjectSource } from '../domain/Project.js'
import type { RepoSource } from '../domain/Repo.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { EventBus } from '../events/EventBus.js'
import type { Pipeline } from '../pipeline/Pipeline.js'
import type { AgentSource } from './Agent.js'
import { Execution, type ExecutionMessage } from './Execution.js'

/**
 * Tope de la cadena de derivación de eventos (EmitAction, AgentAction con
 * emitOn: 'exit'). Sin esto, un pipeline que se re-emite a sí mismo —directo,
 * o a través de un ciclo de N pipelines— no tiene fondo: cada evento derivado
 * vuelve a matchear el mismo pipeline y dispara otro. Equivalente a
 * EngineEvent.depth en v1.
 */
export const MAX_EVENT_DEPTH = 10

/** Fuente en vivo del roster de Pipeline — inyectada, nunca cacheada acá.
 *  `Engine.dispatch` la consulta en CADA evento (mismo criterio que
 *  `RuleEngineHandler.loadRules` en v1: lee `ruleRepo.visibleTo(...)` por
 *  evento, nunca cachea reglas), así que una Pipeline editada en la UI
 *  aplica en el próximo dispatch. */
export interface PipelineSource {
  list(): Promise<Pipeline[]>
  list(projectId: string): Promise<Pipeline[]>
}

/**
 * Todo lo que el engine necesita LEER del mundo, en vivo. Se inyecta una vez,
 * por constructor, y viaja a cada paso dentro de `PipelineExecutionContext` —
 * nunca como estado estático de las entidades: dos `Engine` en el mismo
 * proceso (el daemon y un test) pueden tener fuentes distintas, y leer la
 * firma de `new Engine(...)` alcanza para saber de qué depende.
 */
export interface EngineSources {
  pipelines: PipelineSource
  projects: ProjectSource
  agents: AgentSource
  repos: RepoSource
}

/**
 * Dueño de despachar cada evento del bus contra el roster de Pipeline vivo.
 * Equivalente a rule-engine-handler.ts + TaskDispatcher + SourceIssueManager
 * de v1, colapsados: acá no hay scan — todo entra como DomainEvent (lo que en
 * v1 produce el scan queda afuera de este esqueleto, es quien PUBLICA al bus).
 */
export class Engine {
  constructor(
    private readonly bus: EventBus,
    private readonly sources: EngineSources,
  ) {}

  start(): void {
    this.bus.subscribe('*', (event) => {
      void this.dispatch(event)
    })
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
  /**
   * `'dispatched'`/`'skipped'` — no `'deferred'`: eso es una decisión de
   * capacidad que hoy vive en `Execution.withinCap` DENTRO de `AgentAction`,
   * no algo que el `Engine` pueda ver desde afuera. El valor de retorno
   * existe para que un puente hacia OTRO bus (uno que sí distinga los tres,
   * como `@ia-flow/rules`) pueda reportar algo mejor que "no sé" — el propio
   * `EventBus` de v2 sigue siendo fire-and-forget y lo ignora.
   */
  async dispatch(event: DomainEvent): Promise<'dispatched' | 'skipped'> {
    if (event.depth >= MAX_EVENT_DEPTH) return 'skipped'

    const taskId = event.scope?.issueId
    const message: ExecutionMessage = {
      body: JSON.stringify(event.payload),
      origin: event.type,
      occurredAt: event.occurredAt,
      payload: event.payload,
    }
    if (Execution.tryAppend(taskId, message)) return 'dispatched'

    const project = event.scope?.projectId
      ? this.sources.projects.get(event.scope.projectId)
      : undefined
    const pipelines = await this.sources.pipelines.list()
    const matched = pipelines.filter((p) => p.matches(event, project))
    const survived: Pipeline[] = []
    for (const p of matched) {
      if (await p.matchesText(event)) survived.push(p)
    }

    const exclusive = survived.filter((p) => p.exclusive).sort((a, b) => a.position - b.position)[0]
    const toRun = exclusive ? [exclusive] : survived.filter((p) => !p.exclusive)
    if (toRun.length === 0) return 'skipped'

    await Promise.all(
      toRun.map((p) =>
        p.execute({
          event,
          steps: {},
          bus: this.bus,
          pipelineId: p.id,
          sources: this.sources,
        }),
      ),
    )
    return 'dispatched'
  }
}
