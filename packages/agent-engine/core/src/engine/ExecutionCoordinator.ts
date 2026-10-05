import { createLogger, inFreshContext, taggedSync, traced } from '@ia-flow/telemetry'
import { YIELD_TOOL_NAME } from '../agent/YieldTool.js'
import type { CapabilityInvoker } from '../capability/Capabilities.js'
import type { TextClassifier } from '../condition/TextClassifier.js'
import { createEvent, type DomainEvent } from '../events/DomainEvent.js'
import type { EventBus } from '../events/EventBus.js'
import type { Pipeline, Resumption } from '../pipeline/Pipeline.js'
import type {
  ExecutionHandle,
  Interruption,
  PipelineExecutionContext,
} from '../pipeline/Runnable.js'
import type { ConcurrencyLimits } from './ConcurrencyLimits.js'
import type { Candidate, DispatchPlanner } from './DispatchPlanner.js'
import type { Execution, Wake } from './Execution.js'
import type { ExecutionStore } from './ExecutionStore.js'
import type { DispatchOutcome, RunLauncher } from './RunLauncher.js'
import { expireTrace, ifRunningTag, offerTag } from './tracing.js'

/** Lo que pasó al ofrecerle el evento a la ejecución de su task: se le entregó a su paso activo,
 *  o despertó su pausa (con la corrida que la reanuda). */
export type Offer =
  | { kind: 'injected'; executionId: string; stepId?: string }
  | {
      kind: 'resumed'
      executionId: string
      branch: string
      /** La corrida que la reanuda — ausente si ya la lanzó otro (ver `wakeLate`). */
      run?: () => Promise<unknown>
      detach?: boolean
    }

/**
 * Qué hizo el engine con una pipeline que matcheó, frente a la ejecución de su task:
 * - `direct`: no pasa por ejecuciones (sin `executions`, sin agentes o sin task).
 * - `nested`: nació dentro de la ejecución en curso — corre sin esperarla.
 * - `starts`: la task está libre, abre su ejecución.
 * - `waits`: la task está ocupada — corre cuando se libere (`ifRunning: wait`).
 * - `interrupts`: como `waits`, y además interrumpió al agente que corría (`ifRunning: interrupt`).
 * - `injected`: no corre — el evento ya lo recibió el paso activo de la task (`agentId`).
 * - `resumed`: no corre — el evento reanudó la ejecución pausada de la task.
 * - `skipped`: la task está ocupada y la regla es `skip`.
 */
export interface Resolution {
  decision:
    | 'direct'
    | 'nested'
    | 'starts'
    | 'waits'
    | 'interrupts'
    | 'injected'
    | 'resumed'
    | 'skipped'
  /** La corrida a lanzar, salvo `injected`/`skipped`. */
  run?: () => Promise<unknown>
  /** Corre sin que `dispatch` la espere (ver `RunLauncher.detach`). */
  detach?: boolean
  /** La ejecución con la que chocó: la que corre en la task, si ya arrancó. */
  executionId?: string
  agentId?: string
}

export interface ExecutionCoordinatorOptions {
  bus: EventBus
  planner: DispatchPlanner
  launcher: RunLauncher
  executions?: ExecutionStore
  executionKey: (event: DomainEvent<any>) => string | undefined
  formatMessage: (event: DomainEvent<any>) => string
  /** Qué hacer con lo inyectado que nadie leyó cuando una ejecución cierra o se pausa. */
  redispatch: (unread: DomainEvent<any>[], executionId: string) => void
  /** Quién evalúa los `whenText` de los pasos. */
  classifier?: TextClassifier
  /** Las capacidades que ven los pasos (`ctx.capabilities`). */
  capabilities?: CapabilityInvoker
  /** Los topes por agente y provider (`ctx.limits`). */
  limits?: ConcurrencyLimits
  /** Si `event` lo produjo el propio sistema: no interrumpe (ver `EngineOptions`). */
  selfOriginated?: (event: DomainEvent<any>) => boolean
  /** Qué pasó, para leer, cuando `pipeline` interrumpe por `event` (ver `EngineOptions`). */
  interruptReason?: (event: DomainEvent<any>, pipeline: Pipeline) => string
}

function defaultInterruptReason(event: DomainEvent<any>, pipeline: Pipeline): string {
  return `llegó "${event.type}" y va a correr "${pipeline.id}"`
}

/** El aviso que lee el agente interrumpido en su próxima vuelta. */
export function interruptNotice({ reason }: Interruption): string {
  return [
    `⚠️ Interrupción: ${reason}. Otra ejecución va a retomar esta task apenas termines.`,
    `Dejá lo que estás haciendo en un estado consistente (sin cambios a medias) y cerrá tu turno YA con \`${YIELD_TOOL_NAME}\`, contando en qué quedaste: qué hiciste, qué falta y lo que el siguiente necesite saber.`,
    'No elijas ninguna salida (submit_*) ni sigas con el trabajo.',
  ].join('\n')
}

/**
 * Todo lo que pasa entre un evento y la ejecución de su task: ofrecérselo a su paso activo,
 * despertar su pausa, decidir qué hace cada regla que matchea si la task está ocupada, vencer las
 * pausas y correr cada pipeline como su ejecución. Sin `executions`, todo corre directo.
 */
export class ExecutionCoordinator {
  readonly log = createLogger('agent-engine.engine')
  private readonly bus: EventBus
  private readonly planner: DispatchPlanner
  private readonly classifier?: TextClassifier
  private readonly capabilities?: CapabilityInvoker
  private readonly limits?: ConcurrencyLimits
  private readonly launcher: RunLauncher
  readonly executions?: ExecutionStore
  private readonly executionKey: (event: DomainEvent<any>) => string | undefined
  private readonly formatMessage: (event: DomainEvent<any>) => string
  private readonly redispatch: ExecutionCoordinatorOptions['redispatch']
  private readonly selfOriginated: (event: DomainEvent<any>) => boolean
  private readonly interruptReason: (event: DomainEvent<any>, pipeline: Pipeline) => string
  /** Los eventos que ya despertaron una pausa desde `wakeLate` — mientras su propio `dispatch`
   *  todavía leía las reglas: cuando termina, el evento ya está usado y no las corre. */
  private readonly wokeLate = new WeakMap<
    DomainEvent<any>,
    { executionId: string; branch: string }
  >()
  /** La primera ejecución que abrió cada evento — lo que su `dispatch` anota en el journal. */
  private readonly opened = new WeakMap<DomainEvent<any>, string>()

  constructor(opts: ExecutionCoordinatorOptions) {
    this.bus = opts.bus
    this.planner = opts.planner
    this.launcher = opts.launcher
    this.executions = opts.executions
    this.executionKey = opts.executionKey
    this.formatMessage = opts.formatMessage
    this.redispatch = opts.redispatch
    this.classifier = opts.classifier
    this.capabilities = opts.capabilities
    this.limits = opts.limits
    this.selfOriginated = opts.selfOriginated ?? (() => false)
    this.interruptReason = opts.interruptReason ?? defaultInterruptReason
  }

  /**
   * Le ofrece `event` al paso activo de la ejecución en curso de su task (`Execution.inject`,
   * que le pregunta al paso con `accepts`). Un evento que nació en esa misma ejecución no se le
   * ofrece: sería mandarse un mensaje a sí misma.
   */
  @taggedSync(offerTag)
  inject(event: DomainEvent<any>): Offer | undefined {
    const current = this.currentFor(event)
    if (current?.status !== 'running') return undefined
    if (!current.inject(this.formatMessage(event), event)) return undefined
    return {
      kind: 'injected',
      executionId: current.id,
      ...(current.active?.id ? { stepId: current.active.id } : {}),
    }
  }

  /**
   * Si la ejecución de la task está pausada y `event` pasa una de sus ramas, la despierta
   * (`Execution.wake`) y devuelve la corrida que la reanuda. No la despierta si ya hay una corrida
   * en cola sobre la task (`busy`): esa corrida la va a reemplazar, y reanudarla después sería
   * seguir desde un checkpoint viejo.
   */
  @taggedSync(offerTag)
  wake(event: DomainEvent<any>): Offer | undefined {
    const current = this.currentFor(event)
    if (current?.status !== 'paused' || this.executions?.busy(current.key)) return undefined
    const wake = current.wake(event)
    return wake ? this.resumption(current, wake, event) : undefined
  }

  /** Si `event` ya despertó una pausa desde `wakeLate` (mientras su `dispatch` leía las reglas):
   *  lo que su `dispatch` tiene que reportar, sin volver a lanzar la corrida. */
  wokenLate(event: DomainEvent<any>): Offer | undefined {
    const late = this.wokeLate.get(event)
    return late ? { kind: 'resumed', ...late } : undefined
  }

  /** La ejecución que abrió `event`, si ya abrió alguna (la primera, si abrió varias). */
  openedBy(event: DomainEvent<any>): string | undefined {
    return this.opened.get(event)
  }

  /** Recuerda la primera ejecución que abrió `event`. */
  private noteOpened(event: DomainEvent<any>, executionId: string): void {
    if (!this.opened.has(event)) this.opened.set(event, executionId)
  }

  /** La ejecución (corriendo o pausada) de la task de `event`, si hay. */
  currentId(event: DomainEvent<any>): string | undefined {
    const key = this.executions ? this.executionKey(event) : undefined
    return key === undefined ? undefined : this.executions?.current(key)?.id
  }

  /**
   * Qué hacer con una pipeline que matcheó (ver `Resolution`). Sincrónico a propósito: decide y
   * marca la task ocupada sin ceder el turno, así otro despacho no la ve libre a medias. Lo que
   * decidió queda en la traza del evento (`ifRunningTag`).
   *
   * Sólo las pipelines que necesitan ejecución, en un engine con `executions` y un evento con
   * task, pasan por las ejecuciones — el resto (reacciones sin agentes) corre como siempre, aunque
   * el evento se haya inyectado.
   */
  @taggedSync(ifRunningTag)
  resolveRunning(candidate: Candidate, event: DomainEvent<any>, offer?: Offer): Resolution {
    const { pipeline } = candidate
    const executions = this.executions
    const key = executions && pipeline.needsExecution ? this.executionKey(event) : undefined
    const direct = () => this.runPipeline(candidate, event)
    if (!executions || key === undefined) return { decision: 'direct', run: direct }

    // La ejecución de la task ya lo recibió (su paso activo, o reanudándose): otra corrida de
    // agentes sobre la misma task sería hacer el trabajo dos veces.
    if (offer) {
      return {
        decision: offer.kind,
        executionId: offer.executionId,
        ...(offer.kind === 'injected' && offer.stepId ? { agentId: offer.stepId } : {}),
      }
    }
    const current = executions.current(key)
    const executionId = current?.id
    if (current?.owns(event)) return { decision: 'nested', run: direct, executionId }

    const busy = executions.busy(key)
    if (pipeline.ifRunning === 'skip' && busy) return { decision: 'skipped', executionId }
    const interrupted =
      busy && current && pipeline.interrupts(event)
        ? this.interrupt(current, pipeline, event)
        : false

    const run = async () => {
      const execution = await executions.start({
        key,
        pipelineId: pipeline.id,
        ifPaused: pipeline.ifPaused,
        ifQueued: pipeline.ifQueued,
      })
      // Otra corrida de la misma pipeline llegó mientras ésta esperaba y la reemplazó.
      if (!execution) return undefined
      this.noteOpened(event, execution.id)
      // El tope se cuenta recién acá, con el turno tomado: lo anterior de la task ya terminó, y
      // una corrida reemplazada o salteada no cuenta.
      if (this.exhausted(pipeline, key, event, executions)) {
        return this.runAsExecution(execution, () => this.runExhausted(candidate, event, execution))
      }
      return this.runAsExecution(execution, () => this.runPipeline(candidate, event, execution))
    }
    return {
      decision: interrupted ? 'interrupts' : busy ? 'waits' : 'starts',
      run,
      // Nacido dentro de OTRA ejecución (hacia esta task): no se espera, ver `RunLauncher.detach`.
      detach: event.executionId !== undefined,
      ...(executionId ? { executionId } : {}),
    }
  }

  /** Si `pipeline` ya agotó su `maxRuns` para la task (y, si no, cuenta esta corrida). Sólo cuentan
   *  los disparos que pasan su `counts`. */
  private exhausted(
    pipeline: Pipeline,
    key: string,
    event: DomainEvent<any>,
    executions: ExecutionStore,
  ): boolean {
    const budget = pipeline.maxRuns
    if (!budget?.counts(event)) return false
    const { allowed, count } = executions.admitRun(key, budget)
    if (allowed) return false
    this.log.warn(
      `${pipeline.id}: la task agotó su tope de corridas (${count}/${budget.max}, contador "${budget.counter}") — corre onExhausted`,
      {
        'ia.pipeline.id': pipeline.id,
        'ia.pipeline.runs': count,
        'ia.pipeline.max_runs': budget.max,
      },
    )
    return true
  }

  /**
   * Los contadores de `maxRuns` que `event` pone en cero (`resetOn`), para su task. Lo llama el
   * `Engine` con TODAS las pipelines de las fuentes (`plan.candidates`): un comentario humano
   * resetea el contador del loop aunque su pipeline no corra por ese evento.
   */
  resetRuns(event: DomainEvent<any>, pipelines: Pipeline[]): void {
    const key = this.executions ? this.executionKey(event) : undefined
    if (key === undefined) return
    for (const pipeline of pipelines) {
      const budget = pipeline.maxRuns
      if (!budget?.resets(event)) continue
      this.executions?.resetRuns(key, budget.counter)
      this.log.info(`${pipeline.id}: "${event.type}" pone en cero el contador "${budget.counter}"`)
    }
  }

  /**
   * Le avisa al agente que corre en la task que viene `pipeline` (`Execution.interrupt`) — salvo que
   * el evento lo haya producido el propio sistema: ése es el eco de lo que la misma ejecución hizo
   * (ej. la tarjeta que movió su ruta), y cortarla por eso sería interrumpirse sola. Sin un agente
   * en su loop no hay a quién avisarle: la regla sólo espera.
   */
  private interrupt(current: Execution, pipeline: Pipeline, event: DomainEvent<any>): boolean {
    if (this.selfOriginated(event)) return false
    const interruption: Interruption = {
      by: pipeline.id,
      event: event.type,
      reason: this.interruptReason(event, pipeline),
    }
    return current.interrupt(interruption, interruptNotice(interruption))
  }

  /**
   * Las pausas vencidas se reanudan por su rama `timeout`, con un evento `execution.expired` que
   * trae el payload de la corrida que pausó (`Checkpoint.payload`) más `executionId`/`pauseId`. Con
   * una corrida ya en cola sobre la task, la pausa no vence: esa corrida la reemplaza.
   */
  expireDue(now: number): void {
    for (const execution of this.executions?.paused() ?? []) {
      if (!execution.expired(now) || this.executions?.busy(execution.key)) continue
      // El error ya lo logueó `@traced` adentro de su span; acá sólo no queda sin manejar.
      inFreshContext(() => this.expire(execution)).catch(() => {})
    }
  }

  @traced(expireTrace)
  private async expire(execution: Execution): Promise<DispatchOutcome> {
    if (this.executions?.busy(execution.key)) return 'skipped'
    const wake = execution.wakeOnTimeout()
    if (!wake) return 'skipped'
    // Con el payload de la corrida que pausó: lo que corre ahora (la rama `timeout`, el agente
    // que se retoma y sus rutas) necesita la task, no sólo qué ejecución venció.
    const saved = wake.checkpoint.payload
    const event = createEvent(
      'execution.expired',
      {
        ...(typeof saved === 'object' && saved !== null ? saved : {}),
        executionId: execution.id,
        pauseId: wake.checkpoint.pauseId,
      },
      wake.checkpoint.scope ? { scope: wake.checkpoint.scope } : {},
    )
    await this.resumption(execution, wake, event).run()
    return 'resumed'
  }

  /** La ejecución de la task de `event`, salvo que el evento haya nacido en ella. */
  private currentFor(event: DomainEvent<any>): Execution | undefined {
    const key = this.executions ? this.executionKey(event) : undefined
    const current = key === undefined ? undefined : this.executions?.current(key)
    return current && !current.owns(event) ? current : undefined
  }

  /**
   * La corrida que reanuda una ejecución que despertó. Le pide lugar al store YA (ocupa la task en
   * este tick); la corrida sigue la pipeline desde su checkpoint por la rama que la despertó.
   */
  private resumption(
    execution: Execution,
    { checkpoint, branch }: Wake,
    event: DomainEvent<any>,
  ): Required<Extract<Offer, { kind: 'resumed' }>> {
    const admitted = (this.executions as ExecutionStore).resume(execution)
    const run = async () => {
      await admitted
      return this.runAsExecution(execution, async () => {
        const candidate = await this.planner.findCandidate(checkpoint)
        return this.runPipeline(candidate, event, execution, { checkpoint, branch })
      })
    }
    return {
      kind: 'resumed',
      executionId: execution.id,
      branch,
      run,
      // Nacido dentro de OTRA ejecución: no se espera, ver `RunLauncher.detach`.
      detach: event.executionId !== undefined,
    }
  }

  /**
   * Corre `work` como `execution` y, al cerrarla o pausarla, re-despacha lo que ningún agente leyó
   * y le ofrece a su pausa lo que llegó antes de que existiera (`wakeLate`).
   */
  private async runAsExecution<T>(execution: Execution, work: () => Promise<T>): Promise<T> {
    try {
      return await execution.run(work)
    } finally {
      this.redispatch(execution.takeUnread(), execution.id)
      this.wakeLate(execution)
    }
  }

  /**
   * Un evento que llegó mientras la ejecución corría —sin que ningún paso lo aceptara— y que la
   * pausa en la que terminó está esperando: sin esto se perdería (llegó antes de que hubiera
   * pausa que despertar). No vuelve a pasar por las reglas: ya pasó cuando llegó.
   */
  private wakeLate(execution: Execution): void {
    const event = execution.takeMissedWake()
    if (!event) return
    const offer = this.wake(event)
    if (offer?.kind !== 'resumed' || !offer.run) return
    this.wokeLate.set(event, { executionId: offer.executionId, branch: offer.branch })
    this.launcher.detach(offer.run, event)
  }

  /** Corre la pipeline de `candidate` para `event` — como `execution` si hay, y desde su
   *  checkpoint si se está reanudando. */
  private runPipeline(
    candidate: Candidate,
    event: DomainEvent<any>,
    execution?: ExecutionHandle,
    from?: Resumption,
  ): Promise<Record<string, unknown>> {
    return candidate.pipeline.execute(this.contextFor(candidate, event, execution), from)
  }

  /** En vez de la pipeline, su `onExhausted` (ver `MaxRuns`). */
  private runExhausted(
    candidate: Candidate,
    event: DomainEvent<any>,
    execution: ExecutionHandle,
  ): Promise<Record<string, unknown>> {
    return candidate.pipeline.exhaust(this.contextFor(candidate, event, execution))
  }

  private contextFor(
    { pipeline, source }: Candidate,
    event: DomainEvent<any>,
    execution?: ExecutionHandle,
  ): PipelineExecutionContext {
    return {
      event,
      steps: {},
      bus: this.bus,
      pipelineId: pipeline.id,
      defaults: source.defaults,
      ...(source.id !== undefined ? { sourceId: source.id } : {}),
      ...(this.classifier ? { classifier: this.classifier } : {}),
      ...(this.capabilities ? { capabilities: this.capabilities } : {}),
      ...(this.limits ? { limits: this.limits } : {}),
      ...(execution ? { execution } : {}),
    }
  }
}
