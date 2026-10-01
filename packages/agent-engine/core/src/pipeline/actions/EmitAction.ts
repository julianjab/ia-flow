import type { ToolInputSchema } from '../../agent/SchemaTool.js'
import { deriveEvent } from '../../events/DomainEvent.js'
import { type PipelineExecutionContext, Runnable, type RunnableProps } from '../Runnable.js'

export interface EmitActionProps extends RunnableProps {
  type: string
  payload?:
    | Record<string, unknown>
    | ((
        ctx: PipelineExecutionContext,
        input: Record<string, unknown> | undefined,
      ) => Record<string, unknown>)
  /** Opcional: qué puede entregarle un agente a este paso como destino de una ruta. Sin
   *  `payload`, el input validado ES el payload del evento derivado. */
  input?: ToolInputSchema
  /**
   * Scope del evento derivado. Sin esto hereda el del padre (`deriveEvent`) — lo que sirve para
   * encadenar pipelines del MISMO scope. Hace falta cuando el scope recién se conoce en un paso
   * anterior: un evento de entrada sin proyecto que un paso resuelve (ej. un webhook cuyo repo
   * mapea a un proyecto) y re-publica ya con `{ projectId }`, para que lo vean las pipelines
   * con scope (que son fail-closed ante un evento sin él).
   */
  scope?:
    | Record<string, unknown>
    | ((
        ctx: PipelineExecutionContext,
        input: Record<string, unknown> | undefined,
      ) => Record<string, unknown> | undefined)
}

/** Publica un DomainEvent derivado — sin llamar a ningún Agent. Útil para "traducir" un paso
 *  en un evento que otro Pipeline escucha, sin acoplar los dos directamente. */
export class EmitAction extends Runnable {
  readonly type: string
  readonly payload?: EmitActionProps['payload']
  readonly input?: ToolInputSchema
  readonly scope?: EmitActionProps['scope']

  constructor(props: EmitActionProps) {
    super(props)
    this.type = props.type
    this.payload = props.payload
    this.input = props.input
    this.scope = props.scope
  }

  override acceptsInput(): ToolInputSchema | undefined {
    return this.input
  }

  async run(ctx: PipelineExecutionContext, input?: unknown): Promise<unknown> {
    const parsed = this.parseInput(this.input, input)
    const payload =
      typeof this.payload === 'function'
        ? this.payload(ctx, parsed)
        : (this.payload ?? parsed ?? {})
    const scope = typeof this.scope === 'function' ? this.scope(ctx, parsed) : this.scope
    const event = deriveEvent(ctx.event, this.type, payload, {
      ...(scope ? { scope } : {}),
      // Nace adentro de esta ejecución: el engine no la hace esperar por ella misma.
      ...(ctx.execution ? { executionId: ctx.execution.id } : {}),
    })
    await ctx.bus.publish(event)
    return event
  }
}
