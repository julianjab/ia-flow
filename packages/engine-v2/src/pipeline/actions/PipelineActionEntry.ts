import type { AgentOutput } from '../../engine/Agent.js'
import type { EngineSources } from '../../engine/Engine.js'
import type { DomainEvent } from '../../events/DomainEvent.js'
import type { EventBus } from '../../events/EventBus.js'
import { Conditional, type ConditionalProps } from '../Conditional.js'

/**
 * Lo que cada PipelineActionEntry recibe al ejecutar. `steps` acumula el
 * output de cada paso anterior de la MISMA pipeline, indexado por su `id`
 * — es lo que permite `{{steps.<id>.output}}` en un paso siguiente.
 *
 * A propósito NO carga una `task` ni ninguna entidad de dominio — sólo
 * `event` (con su `scope`, que ya trae `projectId`/`repos`/`issueId` cuando
 * aplican) y `steps`. Todo lo que viaja entre pasos es un `payload`
 * genérico (`DomainEvent.payload`, o el output de un paso previo), nunca
 * una instancia con comportamiento propio — ver `AgentRunInput.payload` en
 * `engine/Agent.ts`, que es lo que `AgentAction` arma pasando
 * `event.payload` directo, sin resolver nada.
 */
export interface PipelineExecutionContext {
  readonly event: DomainEvent
  readonly steps: Record<string, unknown>
  readonly bus: EventBus
  /** Pipeline.id dueño de este `do` — lo setea Pipeline.execute antes de
   *  correr cada step; AgentAction lo necesita para crear su Execution. */
  readonly pipelineId: string
  /** Las fuentes vivas que recibió el `Engine` — por acá, y no por estado
   *  estático, es como un paso resuelve un Agent/Project/Repo. */
  readonly sources: EngineSources
  /**
   * Schema que el output de ESTE paso debería cumplir, cuando el siguiente
   * `do` de la cadena es un AgentAction que lo necesita como input tipado.
   * A diferencia de `steps` (aditivo), Pipeline.execute lo RECALCULA antes de
   * cada step — no es acumulativo, es sólo "lo que viene después". Ausente
   * cuando no hay paso siguiente o el siguiente no es un agente.
   */
  nextSchema?: AgentOutput
}

export type PipelineActionKind = 'agent' | 'http' | 'emit' | 'script' | 'ref'

export interface PipelineActionEntryProps extends ConditionalProps {
  /** Nombre del paso — si está presente, su output queda en ctx.steps[id]. */
  id?: string
  /** Default: corta la cadena si este paso falla. */
  continueOnError?: boolean
}

/**
 * Base de toda entrada de `Pipeline.do`. Las 5 variantes de v1 (agent/http/emit/
 * script/ref) extienden esto — ver AgentAction, HttpAction, EmitAction,
 * ScriptAction, RefAction. `when`/`whenText` los hereda de `Conditional`; un
 * paso de v1 sólo usa `when` (RuleActionEntrySchema no tiene `whenText`), pero
 * heredar los dos no cuesta nada — un `whenText` ausente ya resuelve `true`.
 *
 * También carga el índice de acciones NOMBRADAS que `RefAction` resuelve
 * (antes `ActionRegistry` aparte) — mismo `Map + get` sin lógica propia que
 * ya se plegó en `Execution`/`Project`, y acá vive naturalmente porque una
 * acción registrada ES una `PipelineActionEntry`.
 */
export abstract class PipelineActionEntry extends Conditional {
  /** Map crudo y no `Catalog<T>` (como Agent/Project/Provider/Tool/...) a
   *  propósito: acá el id lo elige QUIEN REGISTRA (`register(id, action)`),
   *  no sale de un campo de la propia acción — una `PipelineActionEntry` no
   *  tiene por qué tener `id` para poder correr dentro de un `do`. */
  private static readonly byId = new Map<string, PipelineActionEntry>()

  abstract readonly kind: PipelineActionKind
  readonly id?: string
  readonly continueOnError: boolean

  constructor(props: PipelineActionEntryProps = {}) {
    super(props)
    this.id = props.id
    this.continueOnError = props.continueOnError ?? false
  }

  /** Rechaza registrar un `RefAction` — nunca ref-a-ref, mata ciclos sin
   *  necesitar detección en runtime. */
  static register(id: string, action: PipelineActionEntry): void {
    if (action.kind === 'ref') throw new Error(`no se puede registrar un RefAction ("${id}")`)
    PipelineActionEntry.byId.set(id, action)
  }

  static resolve(id: string): PipelineActionEntry | undefined {
    return PipelineActionEntry.byId.get(id)
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    PipelineActionEntry.byId.clear()
  }

  /** Condiciona ESTE paso (no el pipeline entera) — puede leer `steps.*` de pasos previos. */
  shouldRun(ctx: PipelineExecutionContext): boolean {
    return this.matchesConditions({ ...ctx.event.payload, steps: ctx.steps })
  }

  abstract run(ctx: PipelineExecutionContext): Promise<unknown>
}
