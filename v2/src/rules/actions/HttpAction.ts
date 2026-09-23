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

/**
 * Llamar a una API. `url`, `headers` y `body` admiten {{event.payload...}} y
 * ${SECRETO} — el secreto se resuelve DESPUÉS de interpolar el evento, nunca
 * antes, para que un valor que vino del evento no pueda colar un `${...}` que
 * el resolver confunda con uno que escribió el operador.
 *
 * **`url` también resuelve secretos, igual que `headers`/`body` — fiel a
 * `apps/server/src/adapters/actions/http-action.ts` de v1.** No hay
 * allow-list de hosts destino: quien puede editar una Rule con acceso a un
 * secreto puede mandarlo a cualquier URL. Es el mismo riesgo que ya existe en
 * v1 hoy, no algo que este esqueleto introduzca — pero sigue sin mitigación
 * en ninguno de los dos lados. Si se decide acotarlo (allow-list de hosts por
 * secreto, o no interpolar secretos en `url`), el cambio aplica a los dos.
 */
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
