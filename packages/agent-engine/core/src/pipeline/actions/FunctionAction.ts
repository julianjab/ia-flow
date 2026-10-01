import type { ToolInputSchema } from '../../agent/SchemaTool.js'
import { type PipelineExecutionContext, Runnable, type RunnableProps } from '../Runnable.js'

export interface FunctionActionProps extends RunnableProps {
  /** `input`: lo que entregó el agente si el paso es destino de una ruta y declara `input`. */
  fn: (
    ctx: PipelineExecutionContext,
    input: Record<string, unknown> | undefined,
  ) => Promise<unknown> | unknown
  /** Opcional: qué puede entregarle un agente a este paso como destino de una ruta. */
  input?: ToolInputSchema
}

/**
 * Corre una función arbitraria del proceso con el contexto completo — el reemplazo de
 * `ScriptAction` (que en engine-v2/v1 ejecuta un script de shell del repo). Acá no hay
 * shell de por medio: es código TypeScript normal, así que no hereda el riesgo de comandos
 * arbitrarios ni necesita una allow-list de env vars.
 */
export class FunctionAction extends Runnable {
  readonly fn: FunctionActionProps['fn']
  readonly input?: ToolInputSchema

  constructor(props: FunctionActionProps) {
    super(props)
    this.fn = props.fn
    this.input = props.input
  }

  override acceptsInput(): ToolInputSchema | undefined {
    return this.input
  }

  async run(ctx: PipelineExecutionContext, input?: unknown): Promise<unknown> {
    return this.fn(ctx, this.parseInput(this.input, input))
  }
}
