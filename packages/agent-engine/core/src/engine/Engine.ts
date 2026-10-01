import { createLogger, traced } from '@ia-flow/telemetry'
import {
  Capabilities,
  type CapabilityBindings,
  type CapabilityInvoker,
} from '../capability/Capabilities.js'
import { CapabilityTextClassifier } from '../condition/CapabilityTextClassifier.js'
import type { TextClassifier } from '../condition/TextClassifier.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { EventBus, Unsubscribe } from '../events/EventBus.js'
import type { Pipeline } from '../pipeline/Pipeline.js'
import { ConcurrencyLimits } from './ConcurrencyLimits.js'
import {
  type DispatchDecision,
  type DispatchJournal,
  type DispatchRecord,
  dispatchDecisions,
} from './DispatchJournal.js'
import { type DispatchPlan, DispatchPlanner } from './DispatchPlanner.js'
import { ExecutionCoordinator } from './ExecutionCoordinator.js'
import type { ExecutionStore } from './ExecutionStore.js'
import type { PipelineSource } from './PipelineSource.js'
import { Redelivery } from './Redelivery.js'
import { type DispatchOutcome, RunLauncher } from './RunLauncher.js'
import { dispatchTrace } from './tracing.js'

/** Tope de la cadena de derivación de eventos (EmitAction, Agent.emitOn). Sin esto un
 *  Pipeline que se re-emite a sí mismo —directo o vía un ciclo de N pipelines— no tiene fondo. */
export const DEFAULT_MAX_EVENT_DEPTH = 10

export interface EngineOptions {
  bus: EventBus
  /** Una fuente, o varias (ej. una por proyecto de la app): cada una con su propio filtro y sus
   *  defaults. La prioridad `exclusive`/`position` se decide entre TODAS. */
  pipelines: PipelineSource | PipelineSource[]
  maxEventDepth?: number
  /**
   * Con esto, cada corrida de una pipeline con agentes es una EJECUCIÓN de la task del evento:
   * una task nunca corre dos a la vez, y un evento para una task con una ejecución en curso se le
   * ofrece primero a su paso activo (`injects` del agente) — o, si está pausada, a su pausa, que
   * la reanuda si es un evento que espera. Si no, cada regla decide con su `ifRunning` (esperar o
   * descartarlo). Sin esto, el comportamiento es el de siempre: todo lo que matchea corre en
   * paralelo, y una `PauseAction` falla.
   */
  executions?: ExecutionStore
  /** A qué task pertenece un evento. Default: el `scope` del evento (sin scope, no hay task y no
   *  hay ejecución). */
  executionKey?: (event: DomainEvent<any>) => string | undefined
  /** Cómo se lee un evento inyectado en la conversación del agente. Default: tipo + payload. */
  formatMessage?: (event: DomainEvent<any>) => string
  /**
   * Quién cumple cada `Capability` por nombre (`whenText`, `fileFocus`, …): un `Runnable` —
   * típicamente un `Agent` con un modelo chico —, fijo o resuelto en cada pedido. Una capacidad
   * sin nadie está apagada y quien la pide degrada (un `whenText` no corre, `fs_read` ignora
   * `focus`).
   */
  capabilities?: CapabilityBindings
  /** Quién evalúa los `whenText`. Default: la capacidad `whenText` (`CapabilityTextClassifier`). */
  textClassifier?: TextClassifier
  /**
   * Aplicar los topes por agente (`AgentDefinitionProps.maxConcurrent`) y por provider
   * (`Provider.maxConcurrent`, `canAccept`). Default: sí. Un agente pide su lugar al entrar a su
   * paso — con su ejecución ya en curso —, así que el tope global (`executions`) sigue siendo el
   * techo. Uno que corre fuera de una pipeline (capacidad, sub-agente) no los ocupa.
   */
  limits?: boolean
  /**
   * Si un evento lo produjo el propio sistema (ej. un webhook cuyo `sender` es el bot del engine):
   * nunca interrumpe (`ifRunning: 'interrupt'`), sólo espera. Es la red contra que un agente se
   * interrumpa solo con el eco de algo que hizo su propia ejecución — un evento emitido ADENTRO de
   * ella ya no la espera (`executionId`), pero el eco que vuelve por un webhook no lo trae.
   * Default: ninguno.
   */
  selfOriginated?: (event: DomainEvent<any>) => boolean
  /** Qué pasó, en palabras, cuando `pipeline` interrumpe por `event` — lo lee el agente en el
   *  aviso y queda en `steps.interruption.reason` (ej. "la tarjeta pasó a Review"). Default: el
   *  tipo del evento y la pipeline que viene. */
  interruptReason?: (event: DomainEvent<any>, pipeline: Pipeline) => string
  /** Dónde anotar cada evento despachado y qué se decidió con él (ver `DispatchJournal`). */
  dispatchJournal?: DispatchJournal
}

/** La task de un evento: su `scope` con las claves ordenadas — dos eventos de la misma task
 *  dan la misma clave aunque el scope se haya armado en otro orden. */
export function scopeExecutionKey(event: DomainEvent<any>): string | undefined {
  const scope = event.scope ?? {}
  const keys = Object.keys(scope).sort()
  if (keys.length === 0) return undefined
  return JSON.stringify(keys.map((key) => [key, scope[key]]))
}

/** El mensaje de un error — el de cada corrida, si fallaron varias (`AggregateError`). */
function errorMessage(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return `${err.message}: ${err.errors.map(errorMessage).join('; ')}`
  }
  return err instanceof Error ? err.message : String(err)
}

function defaultMessage(event: DomainEvent<any>): string {
  return `Evento ${event.type}: ${JSON.stringify(event.payload)}`
}

/**
 * Dueño de despachar cada evento del bus contra el roster de Pipeline vivo. No sabe nada de
 * GitHub, Slack ni viajes — todo eso vive en cómo cada app traduce su mundo a `DomainEvent`
 * y en qué Agents registra. Esto es el harness; el dominio lo trae quien lo usa.
 *
 * Es la fachada: qué corre lo decide `DispatchPlanner`, qué pasa frente a la ejecución de la task
 * `ExecutionCoordinator`, cómo se lanzan las corridas `RunLauncher`, y lo inyectado que nadie
 * leyó lo re-despacha `Redelivery`.
 */
export class Engine {
  readonly log = createLogger('agent-engine.engine')
  private readonly bus: EventBus
  readonly maxEventDepth: number
  private readonly planner: DispatchPlanner
  private readonly launcher: RunLauncher
  private readonly coordinator: ExecutionCoordinator
  private readonly redelivery: Redelivery
  private readonly dispatchJournal?: DispatchJournal
  /** Las capacidades enchufadas: la app también las pide (ej. el asistente de la web). */
  readonly capabilities: CapabilityInvoker

  constructor(opts: EngineOptions) {
    this.bus = opts.bus
    this.maxEventDepth = opts.maxEventDepth ?? DEFAULT_MAX_EVENT_DEPTH
    this.dispatchJournal = opts.dispatchJournal
    const capabilities = new Capabilities(opts.capabilities ?? {}, opts.bus)
    this.capabilities = capabilities
    const classifier = opts.textClassifier ?? new CapabilityTextClassifier(capabilities)
    this.planner = new DispatchPlanner([opts.pipelines].flat(), classifier)
    this.launcher = new RunLauncher()
    this.coordinator = new ExecutionCoordinator({
      bus: opts.bus,
      planner: this.planner,
      launcher: this.launcher,
      executions: opts.executions,
      executionKey: opts.executionKey ?? scopeExecutionKey,
      formatMessage: opts.formatMessage ?? defaultMessage,
      redispatch: (unread, executionId) => this.redelivery.redispatch(unread, executionId),
      classifier,
      capabilities,
      ...(opts.limits === false ? {} : { limits: new ConcurrencyLimits() }),
      ...(opts.selfOriginated ? { selfOriginated: opts.selfOriginated } : {}),
      ...(opts.interruptReason ? { interruptReason: opts.interruptReason } : {}),
    })
    this.redelivery = new Redelivery({
      planner: this.planner,
      launcher: this.launcher,
      coordinator: this.coordinator,
    })
    // Lo que las ejecuciones interrumpidas por un reinicio recibieron sin leer (un store
    // persistente): se re-despacha igual que lo que deja una ejecución que cierra.
    for (const { executionId, events } of opts.executions?.takeOrphaned() ?? []) {
      this.redelivery.redispatch(events, executionId)
    }
  }

  get executions(): ExecutionStore | undefined {
    return this.coordinator.executions
  }

  /**
   * Suscribe el Engine a todo el bus. Llamalo una vez al bootear la app.
   *
   * A diferencia de una llamada directa a `dispatch`, acá no hay quien reciba la promesa —
   * por eso SE LA DEVOLVEMOS al handler en vez de descartarla con `void`: `EventBus.publish`
   * la junta con las de los demás handlers vía `Promise.allSettled` y agrupa cualquier
   * rechazo en un `AggregateError` que sí llega a quien llamó `publish`. Descartarla acá
   * (como hacía la versión anterior) dejaba un unhandled rejection cada vez que un `Agent`
   * con `provider` desconocido o un `HttpAction` con respuesta no-2xx tiraban — en Node eso
   * termina el proceso.
   */
  start(): Unsubscribe {
    return this.bus.subscribe('*', (event) => this.dispatch(event))
  }

  /**
   * Evalúa los Pipelines contra `event` y corre los que matchean: TODAS las no-exclusive
   * matcheadas en paralelo (son independientes); si alguna matcheada es `exclusive`, en
   * cambio corre SÓLO la de mayor prioridad (menor `position`) entre las exclusive — MÁS
   * cualquier pipeline (exclusive o no) de prioridad todavía mayor que esa (position aún
   * menor), que no queda bloqueada por una exclusive de menor prioridad que ella misma.
   *
   * Con un `dispatchJournal`, cada evento queda anotado una vez al terminar el despacho: qué hizo
   * cada pipeline que lo escucha, el resultado y la ejecución que tocó — también si lo descartó el
   * tope de profundidad o si tiró.
   */
  @traced(dispatchTrace)
  async dispatch(event: DomainEvent<any>): Promise<DispatchOutcome> {
    if (event.depth >= this.maxEventDepth) {
      this.journal({ event, decisions: [], outcome: 'skipped' })
      return 'skipped'
    }

    let plan: DispatchPlan | undefined
    try {
      // Primero la ejecución de su task. Si corre y su paso activo acepta el evento, ya lo
      // recibió — antes de ceder el turno, así el paso no sale de su loop en el medio.
      const injected = this.coordinator.inject(event)
      if (injected) this.redelivery.rememberOrigin(event)
      plan = await this.planner.decide(event)
      // Si está pausada y el evento la despierta, se reanuda — recién acá, pegado a lanzar la
      // corrida: despertarla antes de `decide` dejaría una ejecución despierta sin quién la corra
      // si `decide` falla.
      const offer = injected ?? this.coordinator.wokenLate(event) ?? this.coordinator.wake(event)
      // Anotado ya, con lo previsto: una corrida de un agente dura minutos y el evento tiene que
      // verse mientras tanto. Al terminar se vuelve a anotar (mismo id) con lo que pasó.
      this.journal({
        event,
        decisions: dispatchDecisions(plan, event),
        outcome: plan.toRun.length > 0 ? 'dispatched' : offer ? 'injected' : 'skipped',
        ...(offer?.executionId ? { executionId: offer.executionId } : {}),
      })
      const outcome = await this.launcher.launch(plan.toRun, event, offer, (candidate) =>
        this.coordinator.resolveRunning(candidate, event, offer),
      )
      const executionId =
        outcome === 'skipped'
          ? undefined
          : (offer?.executionId ??
            this.coordinator.openedBy(event) ??
            this.coordinator.currentId(event))
      this.journal({
        event,
        decisions: dispatchDecisions(plan, event),
        outcome,
        ...(executionId ? { executionId } : {}),
      })
      return outcome
    } catch (err) {
      this.journal({
        event,
        decisions: plan ? dispatchDecisions(plan, event) : [],
        outcome: 'error',
        error: errorMessage(err),
      })
      throw err
    }
  }

  /** Anota el despacho en el journal, si hay. Un journal roto no corta el despacho. */
  private journal(entry: DispatchRecord): void {
    if (!this.dispatchJournal) return
    try {
      this.dispatchJournal.record(entry)
    } catch (err) {
      this.log.warn(`no se pudo anotar el evento "${entry.event.type}": ${errorMessage(err)}`, {
        'ia.event.id': entry.event.id,
      })
    }
  }

  /**
   * "¿Por qué corrió / no corrió?": qué haría cada pipeline que escucha `event`, con el mismo
   * criterio que `dispatch` (y las mismas `DispatchDecision` que anota su journal) — sin correr
   * nada ni anotarlo. Un `whenText` sí consulta al clasificador.
   */
  async explain(event: DomainEvent<any>): Promise<DispatchDecision[]> {
    return dispatchDecisions(await this.planner.plan(event), event)
  }

  /**
   * Las pausas vencidas se reanudan por su rama `timeout`, con un evento `execution.expired`. La
   * app lo llama cada tanto (ej. cada minuto): el engine no tiene reloj propio.
   */
  tick(now = Date.now()): void {
    this.coordinator.expireDue(now)
  }

  /**
   * Las pipelines que corren para `event`, en el mismo orden y con el mismo criterio que
   * `dispatch` — sin correrlas. Para previsualizar (un dry-run, un test) sin duplicar la cascada.
   */
  select(event: DomainEvent<any>): Promise<Pipeline[]> {
    return this.planner.select(event)
  }
}
