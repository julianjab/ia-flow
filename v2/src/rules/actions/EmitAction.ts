import type { DomainEventScope } from '../../events/DomainEvent.js'
import { RuleActionEntry, type RuleActionEntryProps, type RuleExecutionContext } from './RuleActionEntry.js'

export interface EmitActionProps extends RuleActionEntryProps {
  type: string
  scope?: DomainEventScope
  payload?: Record<string, unknown>
}

/** Publica un DomainEvent derivado — permite encadenar sin un DSL de workflow
 *  (un triage normaliza un mensaje suelto en un evento ya ruteable). El
 *  evento nace con causationId + depth+1 del evento que disparó la regla
 *  (deriveEvent en v1) — ver DomainEvent. */
export class EmitAction extends RuleActionEntry {
  readonly kind = 'emit' as const
  readonly type: string
  readonly scope?: DomainEventScope
  readonly payload: Record<string, unknown>

  constructor(props: EmitActionProps) {
    super(props)
    this.type = props.type
    this.scope = props.scope
    this.payload = props.payload ?? {}
  }

  async run(ctx: RuleExecutionContext): Promise<unknown> {
    throw new Error(
      'not implemented — ctx.bus.publish(ctx.event.derive(this.type, this.payload, this.scope)) ' +
        '— derive() ya arma causationId/depth correctamente, Engine.dispatch corta contra MAX_EVENT_DEPTH',
    )
  }
}
