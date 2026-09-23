import {
  RuleActionEntry,
  type RuleActionEntryProps,
  type RuleExecutionContext,
} from './RuleActionEntry.js'

export interface RefActionProps extends RuleActionEntryProps {
  actionId: string
}

/** Correr una acción nombrada aparte (ActionRegistry) — nunca apunta a otra ref. */
export class RefAction extends RuleActionEntry {
  readonly kind = 'ref' as const
  readonly actionId: string

  constructor(props: RefActionProps) {
    super(props)
    this.actionId = props.actionId
  }

  async run(ctx: RuleExecutionContext): Promise<unknown> {
    throw new Error(
      'not implemented — const action = ctx.actions.resolve(this.actionId); return action.run(ctx)',
    )
  }
}
