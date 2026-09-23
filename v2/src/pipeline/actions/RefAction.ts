import {
  PipelineActionEntry,
  type PipelineActionEntryProps,
  type PipelineExecutionContext,
} from './PipelineActionEntry.js'

export interface RefActionProps extends PipelineActionEntryProps {
  actionId: string
}

/** Correr una acción nombrada aparte (PipelineActionEntry.resolve) — nunca apunta a otra ref. */
export class RefAction extends PipelineActionEntry {
  readonly kind = 'ref' as const
  readonly actionId: string

  constructor(props: RefActionProps) {
    super(props)
    this.actionId = props.actionId
  }

  async run(ctx: PipelineExecutionContext): Promise<unknown> {
    const action = PipelineActionEntry.resolve(this.actionId)
    if (action == null) throw new Error(`RefAction: acción desconocida "${this.actionId}"`)
    return action.run(ctx)
  }
}
