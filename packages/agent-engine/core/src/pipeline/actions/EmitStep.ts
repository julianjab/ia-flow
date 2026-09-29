import { type DomainEvent, deriveEvent } from '../../events/DomainEvent.js'
import { render, templateRoot } from '../../template/Template.js'
import { type PipelineExecutionContext, Runnable, type RunnableProps } from '../Runnable.js'

export interface EmitStepProps extends RunnableProps {
  /** El tipo del evento; admite `{{...}}`. */
  type: string
  payload?: unknown
  /** Sin esto, el evento hereda el scope del que lo originó. */
  scope?: unknown
  /** Una lista (`'{{steps.dependents}}'`): un evento por elemento, que las plantillas ven como
   *  `item`. */
  forEach?: string
}

/**
 * El paso `emit` del YAML: publica un evento derivado con el tipo, el payload y el scope
 * resueltos al correr — uno solo, o uno por elemento de `forEach`. Devuelve lo que publicó.
 */
export class EmitStep extends Runnable {
  private readonly props: EmitStepProps

  constructor(props: EmitStepProps) {
    super(props)
    this.props = props
  }

  async run(ctx: PipelineExecutionContext): Promise<unknown> {
    const { forEach } = this.props
    if (forEach === undefined) return this.publish(ctx, templateRoot(ctx))
    const items = render(forEach, templateRoot(ctx)) ?? []
    if (!Array.isArray(items)) {
      throw new Error(`${this.id ?? 'emit'}: forEach no es una lista (${forEach})`)
    }
    const events: DomainEvent<unknown>[] = []
    for (const item of items) events.push(await this.publish(ctx, templateRoot(ctx, { item })))
    return events
  }

  private async publish(
    ctx: PipelineExecutionContext,
    root: Record<string, unknown>,
  ): Promise<DomainEvent<unknown>> {
    const type = String(render(this.props.type, root))
    const payload = this.props.payload === undefined ? {} : (render(this.props.payload, root) ?? {})
    const scope = this.props.scope === undefined ? undefined : render(this.props.scope, root)
    const event = deriveEvent(ctx.event, type, payload, {
      ...(scope ? { scope: scope as Record<string, unknown> } : {}),
      // Nace adentro de esta ejecución: el engine no la hace esperar por ella misma.
      ...(ctx.execution ? { executionId: ctx.execution.id } : {}),
    })
    await ctx.bus.publish(event)
    return event
  }
}
