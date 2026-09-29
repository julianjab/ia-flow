import type { PipelineExecutionContext } from '../Runnable.js'
import { HttpAction, type HttpActionProps } from './HttpAction.js'

export interface HttpStepProps extends HttpActionProps {
  /** Una query GraphQL: la respuesta con `errors` falla, y lo que sigue se lee desde `data`. */
  graphql?: boolean
  /** Qué parte de la respuesta es el output del paso (`repository.issue`, `0.number`). */
  select?: string
}

/** Un `HttpAction` que se queda con la parte de la respuesta que le interesa al resto de la
 *  pipeline — el paso `http` del YAML. */
export class HttpStep extends HttpAction {
  private readonly graphql: boolean
  private readonly select?: string

  constructor(props: HttpStepProps) {
    super(props)
    this.graphql = props.graphql ?? false
    this.select = props.select
  }

  override async run(ctx: PipelineExecutionContext, input?: unknown): Promise<unknown> {
    let out = await super.run(ctx, input)
    if (this.graphql) {
      const { data, errors } = (out ?? {}) as {
        data?: unknown
        errors?: Array<{ message?: string }>
      }
      if (errors?.length) {
        throw new Error(
          `${this.id ?? 'http'}: GraphQL — ${errors.map((error) => error.message).join('; ')}`,
        )
      }
      out = data
    }
    if (!this.select) return out
    return this.select.split('.').reduce<unknown>((acc, key) => {
      if (acc == null || typeof acc !== 'object') return undefined
      return (acc as Record<string, unknown>)[key]
    }, out)
  }
}
