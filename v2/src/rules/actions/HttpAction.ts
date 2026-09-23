import {
  RuleActionEntry,
  type RuleActionEntryProps,
  type RuleExecutionContext,
} from './RuleActionEntry.js'

export interface HttpActionProps extends RuleActionEntryProps {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

/** Llamar a una API. `body`/`headers` admiten {{event.payload...}} y ${SECRETO}
 *  — los secretos los resuelve el engine antes de salir, nunca el modelo. */
export class HttpAction extends RuleActionEntry {
  readonly kind = 'http' as const
  readonly url: string
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly headers: Record<string, string>
  readonly body?: unknown
  readonly timeoutMs?: number

  constructor(props: HttpActionProps) {
    super(props)
    this.url = props.url
    this.method = props.method ?? 'POST'
    this.headers = props.headers ?? {}
    this.body = props.body
    this.timeoutMs = props.timeoutMs
  }

  async run(ctx: RuleExecutionContext): Promise<unknown> {
    throw new Error(
      'not implemented — resolver secretos, interpolar templates, fetch(this.url, {...})',
    )
  }
}
