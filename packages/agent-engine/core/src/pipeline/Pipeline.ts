import { createLogger, traced } from '@ia-flow/telemetry'
import type { Agent } from '../agent/Agent.js'
import type { ConditionalProps } from '../condition/Conditional.js'
import { EventFilter, type EventFilterProps } from '../condition/EventFilter.js'
import type { TextClassifier, WhenText } from '../condition/TextClassifier.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import type {
  ExitDefaults,
  ExitRoutes,
  ResolvedExit,
  ResolvedRoutes,
} from '../routing/ExitRoutes.js'
import type { Pause } from './actions/Pause.js'
import { Checkpoints } from './Checkpoints.js'
import { PipelineGraph } from './PipelineGraph.js'
import { PipelineTrigger } from './PipelineTrigger.js'
import type { InterruptionReport, PipelineExecutionContext, Runnable } from './Runnable.js'
import { StepRunner } from './StepRunner.js'
import { pipelineTrace } from './tracing.js'

/**
 * Por dónde sigue una pipeline pausada. Serializable a propósito (ids e índices, no objetos):
 * es lo que un store persistente guarda para reanudar después de un reinicio.
 */
export interface Checkpoint {
  pipelineId: string
  /** La `PauseAction` que la cortó. */
  pauseId: string
  /** El índice de `do[]` desde el que sigue, después de correr la rama. */
  resumeAt: number
  /** `ctx.steps` al pausarse. */
  steps: Record<string, unknown>
  /** La forma de `do[]` al pausarse: si la pipeline cambió mientras esperaba, `resumeAt`
   *  apuntaría a otro paso — reanudar falla en vez de repetir o saltear pasos. */
  shape: string
  /** La fuente de la pipeline (`PipelineSource.id`): se reanuda ahí, no en otra que tenga una
   *  pipeline con el mismo id. */
  sourceId?: string
  /** El scope del evento, para el evento con el que vence (`execution.expired`). */
  scope?: Record<string, unknown>
  /** El payload del evento de la corrida al pausarse: el de `execution.expired` lo lleva, así lo
   *  que corre al vencer (o al retomar tras un reinicio) ve la task igual que la corrida que
   *  pausó — un `update_issue` sabe qué issue es. */
  payload?: unknown
  /**
   * Lo que el paso `pauseId` necesita para seguir DONDE QUEDÓ en vez de empezar de nuevo: la
   * conversación de un agente que espera un evento (`wait_for_event`), o la que guardaba mientras
   * corría cuando el proceso murió. Opaco para el engine (lo arma y lo lee el provider).
   */
  state?: unknown
  /** Qué pasó mientras tanto, para quien retoma (ej. el runner se reinició). */
  note?: string
  /** Cuántas veces ya se retomó tras un reinicio: el store deja de reintentar pasado un tope. */
  attempts?: number
  /** Cuándo se guardó (ISO). */
  savedAt?: string
}

/** Reanudar una pipeline pausada por una rama de su pausa. */
export interface Resumption {
  checkpoint: Checkpoint
  branch: string
}

/** Por qué corrió un paso — queda en su span (`ia.step.via`): `do` (en orden), `exit:<salida>`,
 *  `report:<salida>`, `onError` u `onError.report`. */
export type StepVia = string

/** Cómo terminó un paso que corrió: su salida (y la del agente, si eligió una, y la pausa si él o
 *  un destino de su salida pausó), o el error que cubrió un `onError`/`continueOnError`. Un error
 *  sin cubrir no llega acá: se propaga. */
export type StepRun =
  | {
      output: unknown
      exit?: { exit: ResolvedExit; payload: Record<string, unknown> }
      paused?: Pause
      /** Lo interrumpieron mientras corría: no siguió sus salidas, corrió su `onInterrupt`. */
      interrupted?: InterruptionReport
    }
  | { error: Error; handledBy: 'onError' | 'continueOnError' }

export type IfRunning = 'wait' | 'skip' | 'interrupt'
export type IfPaused = 'supersede' | 'wait'
export type IfQueued = 'replace' | 'keep'

export interface PipelineProps extends ConditionalProps, ExitDefaults {
  id: string
  /** Tipos de DomainEvent que este pipeline escucha — al menos uno. */
  on: string[]
  /**
   * Filtro sobre `event.scope` — cada clave presente acá tiene que matchear EXACTO en el
   * evento (fail-closed, igual que `Pipeline.matchesScope` de engine-v2, pero genérico:
   * cualquier clave de scope, no sólo projectId/repoName). Ausente = sin restricción.
   */
  scope?: Record<string, unknown>
  enabled?: boolean
  position?: number
  /** Si matchea, impide que corran los pipelines de menor prioridad para este evento. */
  exclusive?: boolean
  /** Los pasos de `do` son ALTERNATIVAS: corre sólo el primero cuyo `when`/`whenText` pasa, y al
   *  reanudar una pausa de ese paso no sigue con los demás. Para una pipeline que elige un agente
   *  por paso (uno por columna, tipo o repo) sin que dos corran para el mismo evento. */
  firstMatch?: boolean
  /**
   * Qué hacer si la task del evento ya tiene una ejecución corriendo (una task nunca corre dos a
   * la vez) y su paso activo no aceptó el evento (`AgentDefinitionProps.injects`). Sólo aplica a
   * pipelines con agentes y a un `Engine` con `executions`:
   * - `wait` (default): espera a que termine y corre después.
   * - `skip`: lo descarta.
   * - `interrupt`: como `wait`, pero además le avisa al agente que está corriendo que viene esta
   *   regla (`Execution.interrupt`): cede su turno, no sigue sus salidas, corre su `onInterrupt`
   *   y ésta arranca apenas cierra. Para reglas que dejan viejo lo que se está haciendo (la
   *   tarjeta cambió de columna). Un evento del propio sistema (`EngineOptions.selfOriginated`)
   *   no interrumpe: espera.
   */
  ifRunning?: IfRunning
  /**
   * Con `ifRunning: 'interrupt'`: QUÉ eventos de esta pipeline interrumpen (`{ on, when }`); los
   * demás esperan como `wait`. Para una pipeline que escucha varios eventos y sólo uno significa
   * "cambió todo" — ej. la de la columna Build corre por un cambio de status (interrumpe) y por la
   * edición de otro campo de la card (espera). Sin esto, todos interrumpen.
   */
  interruptOn?: EventFilterProps[]
  /**
   * Qué hacer si, cuando le toca correr, la task tiene una ejecución PAUSADA (esperando el CI, un
   * review…). Sólo aplica a pipelines con agentes y a un `Engine` con `executions`:
   * - `supersede` (default): corre ya y la pausa queda reemplazada — esta corrida lee el estado
   *   nuevo. Para reglas que traen trabajo nuevo (un CI rojo, la tarjeta vuelta a Build).
   * - `wait`: espera a que la pausa termine (despierte o venza) y corre después. Para reglas que
   *   pueden no hacer nada (un triage de comentarios): reemplazarla se llevaría puesta la espera
   *   aunque no haya nada que hacer, y nadie seguiría desde ahí.
   */
  ifPaused?: IfPaused
  /**
   * Qué hacer si esta pipeline ya tiene una corrida ESPERANDO turno en la task (la task está
   * ocupada y todavía no arrancó). Sólo aplica a pipelines con agentes y a un `Engine` con
   * `executions`; la que ya corre nunca se toca:
   * - `replace` (default): esta corrida reemplaza a la que esperaba — dos cambios de status
   *   seguidos corren una vez, con el último evento.
   * - `keep`: se encola detrás. Para reglas donde cada evento importa (un comentario que el
   *   agente no inyecta): reemplazar perdería el anterior.
   */
  ifQueued?: IfQueued
  do: Runnable[]
  /**
   * Overrides de rutas por agente (clave: el `id` del agente) — el nivel "paso" de la cascada.
   * Cambiar el `to` de una salida, eliminarla con `null`, o cambiar su `onError`/`report`.
   * Nunca crear una salida que el agente no declara.
   */
  routes?: Record<string, ExitRoutes>
}

/**
 * Filtra eventos y recorre su `do`, acumulando el output de cada paso nombrado en `ctx.steps`.
 *
 * Los pasos corren en orden, salvo los que son DESTINO de alguna ruta: esos sólo corren cuando
 * un agente elige la salida que lleva a ellos, con el input que el agente entregó. Al elegir una
 * salida corre primero su `report` (el cierre del turno) y después sus destinos en orden — el
 * orden importa: el siguiente agente tiene que ver ese comentario.
 *
 * Todo el cableado se valida al construir (`PipelineGraph`): salidas sin destino, overrides de
 * salidas o agentes que no existen, ciclos entre agentes, claves repetidas en un `submit_*`. Qué
 * eventos la arrancan es su `PipelineTrigger`; cada paso lo corre su `StepRunner`, y por dónde
 * sigue una pausa lo guarda `Checkpoints`.
 */
export class Pipeline {
  readonly log = createLogger('agent-engine.pipeline')
  readonly id: string
  readonly trigger: PipelineTrigger
  readonly position: number
  readonly exclusive: boolean
  readonly firstMatch: boolean
  readonly ifRunning: IfRunning
  private readonly interruptFilters?: EventFilter[]
  readonly ifPaused: IfPaused
  readonly ifQueued: IfQueued
  readonly do: Runnable[]
  readonly defaults: ExitDefaults
  private readonly graph: PipelineGraph
  private readonly runner: StepRunner
  private readonly checkpoints: Checkpoints

  constructor(props: PipelineProps) {
    this.id = props.id
    this.trigger = new PipelineTrigger({
      on: props.on,
      when: props.when,
      ...(props.whenText ? { whenText: props.whenText } : {}),
      scope: props.scope,
      enabled: props.enabled,
    })
    this.position = props.position ?? 0
    this.exclusive = props.exclusive ?? false
    this.firstMatch = props.firstMatch ?? false
    this.ifRunning = props.ifRunning ?? 'wait'
    this.interruptFilters = props.interruptOn?.map((filter) => new EventFilter(filter))
    this.ifPaused = props.ifPaused ?? 'supersede'
    this.ifQueued = props.ifQueued ?? 'replace'
    this.do = props.do
    this.defaults = {
      onError: props.onError,
      onInterrupt: props.onInterrupt,
      report: props.report,
    }
    this.graph = new PipelineGraph({
      pipelineId: this.id,
      do: this.do,
      defaults: this.defaults,
      stepRoutes: props.routes ?? {},
    })
    this.runner = new StepRunner(this.id, this.graph, this.defaults)
    this.checkpoints = new Checkpoints(this.id, this.do, this.graph)
  }

  /** El gate semántico de la pipeline, si tiene. */
  get whenText(): WhenText | undefined {
    return this.trigger.whenText
  }

  /** Por qué su `whenText` no la deja correr para `event` (ver `Conditional.explainText`). */
  explainText(event: DomainEvent<any>, classifier: TextClassifier | undefined) {
    const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload : {}
    return this.trigger.explainText(payload, classifier, event)
  }

  /** Si `event` interrumpe a la ejecución que corre en su task (`ifRunning` + `interruptOn`). */
  interrupts(event: DomainEvent<any>): boolean {
    if (this.ifRunning !== 'interrupt') return false
    return this.interruptFilters?.some((filter) => filter.matches(event)) ?? true
  }

  /** Tipos de DomainEvent que escucha. */
  get on(): string[] {
    return this.trigger.on
  }

  /** Si cada corrida tiene que ser una ejecución: corre agentes, o puede pausarse (una pausa
   *  sólo existe dentro de una ejecución). */
  get needsExecution(): boolean {
    return this.graph.needsExecution
  }

  /** Las rutas efectivas de un agente en esta pipeline, con el origen de cada una. Con
   *  `project`, incluye los defaults del proyecto — lo que efectivamente va a correr. */
  routesOf(agentId: string, project?: ExitDefaults): ResolvedRoutes {
    return this.graph.routesOf(agentId, project)
  }

  // `DomainEvent<any>`, no el `DomainEvent` a secas (que resuelve a `DomainEvent<Record<string,
  // unknown>>`): el Engine/Pipeline no le exige forma al payload de cada evento — eso es cosa
  // de cada Agent tipado que lo consume — así que forzar el genérico por defecto acá rechazaría
  // cualquier evento creado con un payload propio (`createEvent<GithubIssuePayload>(...)`).
  matches(event: DomainEvent<any>): boolean {
    return this.trigger.matches(event)
  }

  /** Por qué esta pipeline NO corre para `event`, o `undefined` si matchea — lo que queda en la
   *  traza del evento para cada regla que no corrió. */
  explainMismatch(event: DomainEvent<any>): string | undefined {
    return this.trigger.explainMismatch(event)
  }

  /**
   * Corre `this.do` en orden; cada paso puede leer `ctx.steps` de los anteriores. Un paso
   * saltado (`shouldRun` false) no deja rastro en `ctx.steps`. Un error frena el Pipeline
   * salvo que haya un `onError` que lo maneje (del paso — o la cascada completa, si es un
   * agente —, de la pipeline o del proyecto) o el paso tenga `continueOnError`.
   */
  @traced(pipelineTrace)
  async execute(
    ctx: PipelineExecutionContext,
    from?: Resumption,
  ): Promise<Record<string, unknown>> {
    const runCtx: PipelineExecutionContext = {
      ...ctx,
      ...(from ? { steps: { ...from.checkpoint.steps, ...ctx.steps } } : {}),
      pipelineId: this.id,
      routesFor: (step) =>
        step.exitRoutes !== undefined ? this.graph.resolve(step, ctx.defaults) : undefined,
    }
    runCtx.runStep = async (step, via) => {
      if (await this.runner.run(step, undefined, runCtx, via, false)) {
        throw new Error(`Pipeline(${this.id}): "${via}" no puede pausar la ejecución`)
      }
    }
    let resumeAt = 0
    if (from) {
      // Reanudar: primero la rama que la despertó (con el evento que la despertó en
      // `steps.<pausa>`), después el resto de `do[]` desde donde se había cortado. Un paso que
      // pausó a mitad de camino (un agente que espera) retoma con su `state`.
      const targets = this.checkpoints.resume(from)
      const { checkpoint, branch } = from
      runCtx.steps[checkpoint.pauseId] = { branch, event: ctx.event.payload }
      runCtx.resume = {
        step: checkpoint.pauseId,
        branch,
        event: ctx.event,
        state: checkpoint.state,
        ...(checkpoint.note ? { note: checkpoint.note } : {}),
        ...(checkpoint.attempts ? { attempts: checkpoint.attempts } : {}),
      }
      for (const target of targets) {
        this.anchor(runCtx, target, checkpoint.resumeAt)
        const paused = await this.runner.run(target, undefined, runCtx, `resume:${branch}`)
        delete runCtx.resume
        if (paused) return this.checkpoints.save(runCtx, paused, checkpoint.resumeAt)
        if (runCtx.execution?.interruption) return runCtx.steps
      }
      resumeAt = checkpoint.resumeAt
    }
    for (let index = resumeAt; index < this.do.length; index++) {
      const step = this.do[index] as Runnable
      if (this.graph.routed.has(step)) continue
      this.anchor(runCtx, step, index + 1)
      const { ran, paused } = await this.runner.attempt(step, undefined, runCtx, 'do')
      // `firstMatch`: lo que sigue a una alternativa que corrió no corre, tampoco al reanudarla.
      if (paused) {
        return this.checkpoints.save(runCtx, paused, this.firstMatch ? this.do.length : index + 1)
      }
      // Interrumpida: su `onInterrupt` ya corrió (`StepRunner`), lo que sigue es de la que viene.
      if (runCtx.execution?.interruption) break
      if (ran && this.firstMatch) break
    }
    return runCtx.steps
  }

  /** Si el proceso muere mientras `step` (un paso de `do[]`, o el que se retoma) guarda su
   *  progreso, la ejecución sabe retomarlo ahí y seguir desde `resumeAt`. Un paso anidado (el
   *  destino de una salida) no guarda: no hay cómo seguir la lista de destinos a medias. */
  private anchor(ctx: PipelineExecutionContext, step: Runnable, resumeAt: number): void {
    ctx.saveProgress = (from, state) => {
      if (from === step) this.checkpoints.progress(ctx, step, resumeAt, state)
    }
  }
}

/** Type guard útil para quien construye pipelines dinámicamente desde config — distingue un
 *  paso respaldado por LLM de un `Runnable` genérico (Emit/Http/Function). */
export function isAgent(step: Runnable): step is Agent {
  return step.kind === 'agent'
}
