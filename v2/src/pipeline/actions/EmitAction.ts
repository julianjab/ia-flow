import type { DomainEventScope } from '../../events/DomainEvent.js'
import { PipelineActionEntry, type PipelineActionEntryProps, type PipelineExecutionContext } from './PipelineActionEntry.js'

export interface EmitActionProps extends PipelineActionEntryProps {
  type: string
  scope?: DomainEventScope
  payload?: Record<string, unknown>
}

/** Publica un DomainEvent derivado — permite encadenar sin un DSL de workflow
 *  (un triage normaliza un mensaje suelto en un evento ya ruteable). El
 *  evento nace con causationId + depth+1 del evento que disparó el pipeline
 *  (deriveEvent en v1) — ver DomainEvent. */
export class EmitAction extends PipelineActionEntry {
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

  async run(ctx: PipelineExecutionContext): Promise<unknown> {
    const derived = ctx.event.derive(this.type, this.payload, this.scope)
    ctx.bus.publish(derived)
    return derived
  }
}
