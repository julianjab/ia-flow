import {
  RuleActionEntry,
  type RuleActionEntryProps,
  type RuleExecutionContext,
} from './RuleActionEntry.js'

export interface EmitActionScope {
  projectId?: string
  repos?: string[]
  issueId?: string
  prNumber?: number
}

export interface EmitActionProps extends RuleActionEntryProps {
  type: string
  scope?: EmitActionScope
  payload?: Record<string, unknown>
}

/** Publica un DomainEvent derivado — permite encadenar sin un DSL de workflow
 *  (un triage normaliza un mensaje suelto en un evento ya ruteable). */
export class EmitAction extends RuleActionEntry {
  readonly kind = 'emit' as const
  readonly type: string
  readonly scope?: EmitActionScope
  readonly payload: Record<string, unknown>

  constructor(props: EmitActionProps) {
    super(props)
    this.type = props.type
    this.scope = props.scope
    this.payload = props.payload ?? {}
  }

  async run(ctx: RuleExecutionContext): Promise<unknown> {
    throw new Error(
      'not implemented — ctx.bus.publish(new DomainEvent(this.type, {...this.payload, scope: this.scope}))',
    )
  }
}
