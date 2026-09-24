import type { ProjectSource } from '../domain/Project.js'
import type { RepoSource } from '../domain/Repo.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { EventBus } from '../events/EventBus.js'
import type { Pipeline } from '../pipeline/Pipeline.js'
import type { AgentSource } from './Agent.js'
import { AgentRunEntity } from './AgentRunEntity.js'
import { Execution, type ExecutionMessage } from './Execution.js'

/**
 * Fuente en vivo de Executions `waiting` para una task — inyectada, igual
 * que `Agent`/`Project`/`Repo`. A diferencia de esas tres, ESTA tiene que
 * sobrevivir al proceso: una `Execution` corriendo vive en el `Map` estático
 * de `Execution` (efímero a propósito, ver su comentario), pero una pausada
 * puede durar horas — necesita salir de memoria para sobrevivir un reinicio.
 * `consume(id)` es lo que hace que despertarla sea idempotente (mismo
 * criterio que `waitRepo.consume` en v1: el borrado ES la clave).
 */
export interface ExecutionSource {
  list(taskId: string): Promise<Execution[]>
  consume(id: string): Promise<void>
}

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
  executions: ExecutionSource
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
   * 2) ¿despierta a una Execution `waiting`? Gate APARTE del anterior —
   *    "hay un run en vuelo que quiere este mensaje" y "hay alguien
   *    esperando este evento" son preguntas distintas sobre el mismo evento
   *    (mismo motivo por el que v1 separa `WaitHandler` de
   *    `RuleEngineHandler`). Si matchea, se consume (idempotencia — ver
   *    `ExecutionSource.consume`) y `resumeExecution` retoma al AGENTE
   *    original directo (`execution.agentId`) — a propósito NO publica un
   *    evento derivado y espera a que alguna Pipeline lo escuche: ese es
   *    justo el modo en que v1 pierde una task en silencio si nadie
   *    configuró una regla sobre `wait.resumed`. Acá despertar SÍ es
   *    correr, garantizado.
   * 3) si ninguno de los dos matchea, recién ahí evalúa Pipelines desde
   *    cero y las corre: TODAS las no-exclusive matcheadas EN PARALELO
   *    (Promise.all — son pipelines independientes); si alguna matcheada es
   *    `exclusive`, en cambio corre SÓLO la de mayor prioridad (menor
   *    `position`) entre las exclusive, y ninguna otra.
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

    if (taskId != null) {
      const resumable = await this.findResumable(taskId, event)
      if (resumable != null) {
        await this.sources.executions.consume(resumable.id)
        await this.resumeExecution(resumable, event)
        return 'dispatched'
      }
    }

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

  /** Primera Execution `waiting` de esta task cuyo `waitUntil` matchea el
   *  evento — `matchesWaitEvent` es impura (puede consultar un
   *  TextClassifier vía `whenText`), así que no alcanza un `.find()` sync. */
  private async findResumable(taskId: string, event: DomainEvent): Promise<Execution | undefined> {
    for (const execution of await this.sources.executions.list(taskId)) {
      if (await execution.matchesWaitEvent(event)) return execution
    }
    return undefined
  }

  /**
   * Retoma DIRECTO el agente que se pausó — por ahora lo único que crea una
   * Execution `waiting` es un agente (ni HTTP ni Script registran Execution
   * en absoluto, ver ExecutionEntity), así que alcanza con `execution.agentId`:
   * no hace falta resolver la Pipeline dueña ni buscar el `do` puntual por
   * `doId`. El día que otro tipo de `do` pause, esto necesita volver a mirar
   * `execution.kind`.
   *
   * Envuelve el resume en una Execution NUEVA (mismo `pipelineId`/`doId`/
   * `taskId`/`projectId` que la original) para que capacidad y `tryAppend`
   * funcionen sobre el run retomado igual que sobre cualquier otro.
   *
   * Limitaciones honestas de esta primera versión:
   * - `execution.checkpoint` viaja disponible pero nadie lo consume todavía
   *   — `Agent.execute()` no tiene un camino de "retomar conversación real"
   *   (eso necesita que el Provider real lo soporte); por ahora un resume
   *   corre el agente de nuevo con `{ id: taskId, ...event.payload }`, no
   *   con el payload completo de la task original (Execution/ExecutionLog
   *   sólo guardan `taskId`, no el payload entero) ni con el estado exacto
   *   de la conversación pausada.
   * - `payload.id = oldExecution.taskId` es obligatorio, no cosmético:
   *   `Agent.finalize()` indexa el `ExecutionLog` del run por `payload.id`
   *   (no por `Execution.taskId`) — sin esto, el log del run retomado
   *   quedaría en el bucket `''` en vez de bajo la task real.
   * - Sin `workspace`: reconstruir el mismo terreno (repos, worktree) que
   *   tenía el run original queda para cuando el checkpoint real exista —
   *   hoy un agente con `requiresBranch` que se pausa retoma sin worktree.
   */
  private async resumeExecution(oldExecution: Execution, event: DomainEvent): Promise<void> {
    if (oldExecution.agentId == null) return
    const agent = this.sources.agents.get(oldExecution.agentId, oldExecution.projectId)
    if (agent == null) return

    const execution = new Execution({
      id: crypto.randomUUID(),
      pipelineId: oldExecution.pipelineId,
      doId: oldExecution.doId,
      taskId: oldExecution.taskId,
      kind: 'agent',
      entity: new AgentRunEntity(),
      agentId: agent.id,
      projectId: oldExecution.projectId,
    })

    try {
      await agent.run({ payload: { id: oldExecution.taskId, ...event.payload } })
      execution.complete()
    } catch (err) {
      execution.fail()
      throw err
    }
  }
}
