import { render, templateRoot } from '../../template/Template.js'
import { type PipelineExecutionContext, Runnable, type RunnableProps } from '../Runnable.js'
import type { Action } from './Action.js'

export interface ActionStepProps extends RunnableProps {
  action: Action
  /** El input de la acción; sus `{{...}}` se resuelven al correr. */
  with: Record<string, unknown>
}

/**
 * Una acción del catálogo como paso, con un `with` que depende del evento: se resuelve contra el
 * payload y los `steps` en cada corrida, y la acción lo valida contra su schema como a cualquier
 * input. (Un `with` fijo no necesita esto: es `Action.bind`, validado al cargar.)
 */
export class ActionStep extends Runnable {
  private readonly action: Action
  private readonly args: Record<string, unknown>

  constructor(props: ActionStepProps) {
    super(props)
    this.action = props.action
    this.args = props.with
  }

  /** `input` es lo que le da quien lo corre (una ruta, un `onError`); el `with` lo completa. */
  run(ctx: PipelineExecutionContext, input?: unknown): Promise<unknown> {
    const given = typeof input === 'object' && input !== null ? input : {}
    return this.action.run(ctx, { ...given, ...(render(this.args, templateRoot(ctx)) as object) })
  }
}
