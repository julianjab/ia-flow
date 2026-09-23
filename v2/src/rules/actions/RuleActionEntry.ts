import type { Task } from '../../domain/Task.js'
import type { AgentOutput } from '../../engine/Agent.js'
import type { AgentRegistry } from '../../engine/AgentRegistry.js'
import type { DomainEvent } from '../../events/DomainEvent.js'
import type { EventBus } from '../../events/EventBus.js'
import type { ActionRegistry } from '../ActionRegistry.js'
import { Conditional, type ConditionalProps } from '../Conditional.js'

/**
 * Lo que cada RuleActionEntry recibe al ejecutar. `steps` acumula el output
 * de cada paso anterior de la MISMA regla, indexado por su `id` — es lo que
 * permite `{{steps.<id>.output}}` en un paso siguiente. `task` es el issue
 * resuelto para este evento cuando aplica (una acción `http` puede no
 * necesitarlo).
 */
export interface RuleExecutionContext {
  readonly event: DomainEvent
  readonly task?: Task
  readonly steps: Record<string, unknown>
  readonly agents: AgentRegistry
  readonly actions: ActionRegistry
  readonly bus: EventBus
  /**
   * Schema que el output de ESTE paso debería cumplir, cuando el siguiente
   * `do` de la cadena es un AgentAction que lo necesita como input tipado.
   * A diferencia de `steps` (aditivo), Rule.execute lo RECALCULA antes de
   * cada step — no es acumulativo, es sólo "lo que viene después". Ausente
   * cuando no hay paso siguiente o el siguiente no es un agente.
   */
  nextSchema?: AgentOutput
}

export type RuleActionKind = 'agent' | 'http' | 'emit' | 'script' | 'ref'

export interface RuleActionEntryProps extends ConditionalProps {
  /** Nombre del paso — si está presente, su output queda en ctx.steps[id]. */
  id?: string
  /** Default: corta la cadena si este paso falla. */
  continueOnError?: boolean
}

/**
 * Base de toda entrada de `Rule.do`. Las 5 variantes de v1 (agent/http/emit/
 * script/ref) extienden esto — ver AgentAction, HttpAction, EmitAction,
 * ScriptAction, RefAction. `when`/`whenText` los hereda de `Conditional`; un
 * paso de v1 sólo usa `when` (RuleActionEntrySchema no tiene `whenText`), pero
 * heredar los dos no cuesta nada — un `whenText` ausente ya resuelve `true`.
 */
export abstract class RuleActionEntry extends Conditional {
  abstract readonly kind: RuleActionKind
  readonly id?: string
  readonly continueOnError: boolean

  constructor(props: RuleActionEntryProps = {}) {
    super(props)
    this.id = props.id
    this.continueOnError = props.continueOnError ?? false
  }

  /** Condiciona ESTE paso (no la regla entera) — puede leer `steps.*` de pasos previos. */
  shouldRun(ctx: RuleExecutionContext): boolean {
    return this.matchesConditions({ ...ctx.event.payload, steps: ctx.steps })
  }

  abstract run(ctx: RuleExecutionContext): Promise<unknown>
}
