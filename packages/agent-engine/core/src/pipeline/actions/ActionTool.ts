import type { ToolOrigin } from '../../agent/AgentDefinition.js'
import { SchemaTool, type ToolInputSchema } from '../../agent/SchemaTool.js'
import type { PipelineExecutionContext } from '../Runnable.js'
import type { Action } from './Action.js'

/** Una `Action` como tool de un agente, con el `ctx` del paso capturado para cuando el modelo la
 *  llame. El modelo ve el mismo schema que valida la acción. */
export class ActionTool extends SchemaTool<ToolInputSchema> {
  readonly name: string
  readonly description: string
  readonly input: ToolInputSchema
  readonly workspace?: boolean
  readonly origin?: ToolOrigin

  constructor(
    private readonly action: Action,
    private readonly ctx: PipelineExecutionContext,
  ) {
    super()
    this.name = action.id
    this.description = action.description
    this.input = action.input
    if (action.workspace) this.workspace = true
    if (action.origin) this.origin = action.origin
  }

  protected async execute(input: Record<string, unknown>): Promise<string> {
    const out = await this.action.run(this.ctx, input)
    return typeof out === 'string' ? out : JSON.stringify(out ?? null)
  }
}
