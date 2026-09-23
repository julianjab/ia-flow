import type { Task } from '../../domain/Task.js'
import type { AgentRegistry } from '../../engine/AgentRegistry.js'
import type { DomainEvent } from '../../events/DomainEvent.js'
import type { EventBus } from '../../events/EventBus.js'
import type { ActionRegistry } from '../ActionRegistry.js'
import type { Condition } from '../Condition.js'

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
}

export type RuleActionKind = 'agent' | 'http' | 'emit' | 'script' | 'ref'

export interface RuleActionEntryProps {
  /** Nombre del paso — si está presente, su output queda en ctx.steps[id]. */
  id?: string
  /** Condiciona ESTE paso (no la regla entera). Puede leer `steps.*` de pasos previos. */
  when?: Condition[]
  /** Default: corta la cadena si este paso falla. */
  continueOnError?: boolean
}

/** Base de toda entrada de `Rule.do`. Las 5 variantes de v1 (agent/http/emit/
 *  script/ref) extienden esto — ver AgentAction, HttpAction, EmitAction,
 *  ScriptAction, RefAction. */
export abstract class RuleActionEntry {
  abstract readonly kind: RuleActionKind
  readonly id?: string
  readonly when: Condition[]
  readonly continueOnError: boolean

  constructor(props: RuleActionEntryProps = {}) {
    this.id = props.id
    this.when = props.when ?? []
    this.continueOnError = props.continueOnError ?? false
  }

  shouldRun(ctx: RuleExecutionContext): boolean {
    throw new Error(
      'not implemented — Condition.evaluateAll(this.when, {...ctx.event.payload, steps: ctx.steps})',
    )
  }

  abstract run(ctx: RuleExecutionContext): Promise<unknown>
}
