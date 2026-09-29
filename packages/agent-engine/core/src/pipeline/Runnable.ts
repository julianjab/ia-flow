import { z } from 'zod'
import type { ToolInputSchema } from '../agent/SchemaTool.js'
import type { CapabilityInvoker } from '../capability/Capabilities.js'
import { Conditional, type ConditionalProps } from '../condition/Conditional.js'
import type { TextClassifier } from '../condition/TextClassifier.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { EventBus } from '../events/EventBus.js'
import type { ErrorRoute, ExitDefaults, ExitRoutes, ResolvedRoutes } from '../routing/ExitRoutes.js'
import type { Pause } from './actions/Pause.js'
import type { Checkpoint } from './Pipeline.js'

export interface PipelineExecutionContext {
  event: DomainEvent<any>
  /** Outputs acumulados de los pasos anteriores DE ESTE Pipeline, por `id`. */
  steps: Record<string, unknown>
  bus: EventBus
  pipelineId: string
  /** Defaults del proyecto (`onError`, `report`) — el nivel más general de la cascada de rutas.
   *  Lo pone el `Engine` a partir de `PipelineSource.defaults`. */
  defaults?: ExitDefaults
  /** El id de la fuente (`PipelineSource.id`) de esta pipeline — lo guarda una pausa. */
  sourceId?: string
  /** Las rutas efectivas de un agente DENTRO de esta pipeline (sus overrides + los defaults).
   *  Lo pone `Pipeline.execute`; un agente corriendo suelto usa sólo sus rutas base. */
  routesFor?: (step: Runnable) => ResolvedRoutes | undefined
  /** La ejecución de esta corrida, si el `Engine` lleva ejecuciones (ver `ExecutionHandle`). */
  execution?: ExecutionHandle
  /** Corre `step` como un paso más de esta pipeline (su `when`, su span), sin aplicarle ningún
   *  `onError`: si tira, el error sube a quien lo pidió — ej. el `onStart` de un agente. Lo pone
   *  `Pipeline.execute`; un paso que corre suelto no lo tiene. */
  runStep?: (step: Runnable, via: string) => Promise<void>
  /** Quién evalúa los `whenText` (el del paso y el de la pipeline). Sin esto, un paso con
   *  `whenText` no corre. Lo pone el `Engine`. */
  classifier?: TextClassifier
  /** Lo que el engine sabe pedirle a un modelo sin atarse a cuál (`Capability`): una tool que
   *  enfoca un archivo, un gate semántico. Lo pone el `Engine`. */
  capabilities?: CapabilityInvoker
  /** Se está retomando un paso donde quedó (ver `Checkpoint.state`). Lo pone `Pipeline.execute`
   *  mientras corre lo que retoma. */
  resume?: StepResume
  /** Guardar por dónde va `step` (`state`), o borrarlo (`undefined`: terminó), para retomarlo si
   *  el proceso muere. Lo pone `Pipeline.execute` para el paso de `do[]` que corre. */
  saveProgress?: (step: Runnable, state: unknown) => void
}

/** Un paso que se retoma donde quedó: su `id`, por qué rama y con qué evento despertó, y lo que
 *  guardó (`state`). */
export interface StepResume {
  step: string
  branch: string
  event: DomainEvent<any>
  state: unknown
  /** Qué pasó mientras tanto (ej. el runner se reinició). */
  note?: string
  /** Cuántas veces ya se retomó tras un reinicio. */
  attempts?: number
}

/** `agent`: un paso respaldado por un modelo (su span es `agent <id>`). El resto, `action`. */
export type StepKind = 'agent' | 'action'

/** Cómo la `Pipeline` lee lo que devolvió un paso (`Runnable.outcome`). */
export type StepOutcome =
  | { kind: 'output'; output: unknown }
  /** Eligió una salida: la pipeline corre su `report` y sus destinos con `payload`. */
  | { kind: 'exit'; output: unknown; exit: string; payload: Record<string, unknown> }
  /** Pidió pausar la ejecución: la pipeline corta ahí y guarda por dónde seguir. */
  | { kind: 'pause'; pause: Pause }

/** Un paso que pausa la ejecución y se reanuda por ramas (`PauseAction`). */
export interface Resumable {
  readonly id: string
  /** Las ramas por las que se puede reanudar. */
  readonly branchNames: string[]
  /** Lo que corre al reanudar por `branch`. */
  targetsOf(branch: string): Runnable[]
  /** Todo lo que puede correr al reanudar, por cualquier rama. */
  readonly allTargets: Runnable[]
}

/** Por qué se interrumpió una ejecución: llegó un evento para su task y una regla con
 *  `ifRunning: 'interrupt'` va a correr después (ver `Execution.interrupt`). */
export interface Interruption {
  /** La pipeline que viene. */
  by: string
  /** El tipo del evento que la trajo. */
  event: string
  /** Qué pasó, para leer (en el aviso al agente y en `steps.interruption.reason`). */
  reason: string
}

/** Lo que queda en `ctx.steps.interruption` para el `onInterrupt`: la interrupción, el agente que
 *  la recibió y en qué quedó (lo que entregó en `yield_turn`, o el resumen de su provider). */
export interface InterruptionReport extends Interruption {
  agent: string
  progress: string
}

/** La clave de `ctx.steps` donde queda el `InterruptionReport`: reservada, un paso no puede
 *  llamarse así. */
export const INTERRUPTION_STEP = 'interruption'

/** Lo que un paso ve de su ejecución (`engine/Execution.ts`): un agente marca cuándo está en su
 *  loop con el modelo (el paso activo, al que se le ofrece lo que llega) y le pasa el inbox a su
 *  provider; un `EmitAction` marca sus eventos con el `id` para que no esperen a la corrida que
 *  los emitió. */
export interface ExecutionHandle {
  readonly id: string
  /** Cuánto esperó para arrancar (queda en el span de la pipeline). */
  readonly waitedMs?: number
  /** Si la interrumpieron: la pipeline corta después del paso activo y corre su `onInterrupt`. */
  readonly interruption?: Interruption
  enter(step: Runnable): void
  leave(): void
  drain(): string[]
  /** La pipeline se cortó en una `PauseAction`: la ejecución espera hasta que la despierte un
   *  evento (o venza), y guarda por dónde seguir. */
  pause(pause: Pause, checkpoint: Checkpoint): void
  /** Por dónde va el paso activo, para retomarlo si el proceso muere (`undefined`: ya no hay
   *  nada que retomar). Un store persistente lo guarda con la ejecución. */
  progress?(checkpoint: Checkpoint | undefined): void
}

export interface RunnableProps extends ConditionalProps {
  /** Nombre del paso — si se setea, su output queda en `ctx.steps[id]` para pasos siguientes. */
  id?: string
  /** Qué correr si el paso tira — gana sobre el `onError` de la pipeline y del proyecto; `null`
   *  anula los de esos niveles. (Un `Agent` lo declara en su definición: tiene la cascada
   *  completa, con overrides por pipeline.) */
  onError?: ErrorRoute | null
  /** Si el paso tira y ningún `onError` lo maneja, seguir con el siguiente en vez de abortar el
   *  Pipeline. Equivale a un `onError` sin destinos, como último recurso. */
  continueOnError?: boolean
}

/**
 * Base de todo lo que vive en `Pipeline.do[]`. Cada paso ve el `PipelineExecutionContext`
 * completo (no sólo el output del paso anterior) — así un paso puede leer
 * `ctx.steps.triage.output` de cualquier paso nombrado antes, no sólo del inmediato anterior.
 *
 * Contrato único: `EmitAction`/`HttpAction`/`FunctionAction` extienden esto para pasos
 * genéricos, y `Agent` (`../agent/Agent.js`) también — un agente respaldado por un LLM se
 * pone directo en `do[]`, sin un paso intermedio que lo resuelva por id. Antes de esto había
 * dos contratos separados (`PipelineAction` acá, `Agent { id, run(AgentRunInput) }` en
 * `agent/`) con un `AgentAction` puenteándolos vía `AgentRegistry` — la indirección no
 * compraba nada que un import directo del `Agent` ya no diera, así que se colapsó en uno.
 */
export abstract class Runnable extends Conditional {
  readonly id?: string
  readonly onError?: ErrorRoute | null
  readonly continueOnError: boolean

  constructor(props: RunnableProps) {
    super(props)
    this.id = props.id
    this.onError = props.onError
    this.continueOnError = props.continueOnError ?? false
  }

  /**
   * `steps` es una clave RESERVADA en el objeto que evalúan las `when` de un paso — es lo que
   * permite escribir `{ field: 'steps.triage.output.actionable', ... }` (ver el doc de
   * `Pipeline`). Si el `payload` del evento trae su propia clave `steps` (ej. un itinerario de
   * viaje con `{ steps: [...] }` de escalas), esa clave queda tapada por `ctx.steps` a
   * propósito — el `payload` no tiene forma de "ganarle" al reservado. Evitá nombrar un campo
   * de tu dominio `steps` si tu Pipeline usa `when` por-paso.
   */
  shouldRun(ctx: PipelineExecutionContext): boolean {
    if (this.when.length === 0) return true
    const payload = ctx.event.payload
    // Si el payload no es un objeto plano (un string, un número, `null`), el spread de abajo
    // lo trataría como iterable/índices en vez de fallar con claridad — mejor tratarlo como
    // "sin campos propios" y dejar que sólo `steps` quede disponible para la condición.
    const base = typeof payload === 'object' && payload !== null ? payload : {}
    return this.matchesConditions({ ...base, steps: ctx.steps })
  }

  /**
   * El schema del input que este paso acepta cuando lo alcanza una ruta — `undefined` si no
   * acepta ninguno (el default: `EmitAction`, `HttpAction`, `FunctionAction`). `Action` y `Agent`
   * lo sobreescriben; de ahí sale lo que un agente tiene que entregar en su `submit_<salida>`.
   */
  acceptsInput(): ToolInputSchema | undefined {
    return undefined
  }

  get kind(): StepKind {
    return 'action'
  }

  /**
   * Las rutas BASE de un paso que termina eligiendo una salida (un `Agent`): la pipeline les aplica
   * sus overrides y corre los destinos de la elegida. `undefined`: el paso no elige salidas.
   */
  get exitRoutes(): ExitRoutes | undefined {
    return undefined
  }

  /** El paso como pausa que se reanuda por ramas, si lo es (`PauseAction`). */
  asResumable(): Resumable | undefined {
    return undefined
  }

  /** Cómo la pipeline lee lo que devolvió `run`: por default, un output a secas. */
  outcome(output: unknown): StepOutcome {
    return { kind: 'output', output }
  }

  /**
   * Si este paso, mientras es el activo de su ejecución, acepta que le inyecten `event` (lo lee
   * en su próxima vuelta en vez de que el evento espere a que termine). Default: no — sólo un
   * `Agent` en su loop con el modelo tiene quién lo lea.
   */
  accepts(_event: DomainEvent<any>): boolean {
    return false
  }

  /** Valida `input` contra `schema` (o `{}` si no llegó) — el helper que usan los pasos que
   *  declaran un input opcional (`EmitAction`, `HttpAction`, `FunctionAction`). Sin schema,
   *  devuelve `undefined`: el paso no acepta input y lo que llegue se ignora. */
  protected parseInput(
    schema: ToolInputSchema | undefined,
    input: unknown,
  ): Record<string, unknown> | undefined {
    if (!schema) return undefined
    const parsed = schema.safeParse(input ?? {})
    if (!parsed.success) {
      throw new Error(`${this.id ?? 'paso'}: input inválido\n${z.prettifyError(parsed.error)}`)
    }
    return parsed.data as Record<string, unknown>
  }

  /** `input` sólo llega cuando el paso lo ejecuta una ruta (ver `Pipeline`); un paso lineal de
   *  `do[]` lo recibe `undefined`. Los pasos que no aceptan input lo ignoran. */
  abstract run(ctx: PipelineExecutionContext, input?: unknown): Promise<unknown>
}
