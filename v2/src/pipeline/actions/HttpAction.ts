import { getSecretResolver } from '../../infra/SecretResolver.js'
import { Condition } from '../Condition.js'
import {
  PipelineActionEntry,
  type PipelineActionEntryProps,
  type PipelineExecutionContext,
} from './PipelineActionEntry.js'

export interface HttpActionProps extends PipelineActionEntryProps {
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
 * allow-list de hosts destino: quien puede editar una Pipeline con acceso a un
 * secreto puede mandarlo a cualquier URL. Es el mismo riesgo que ya existe en
 * v1 hoy, no algo que este esqueleto introduzca — pero sigue sin mitigación
 * en ninguno de los dos lados. Si se decide acotarlo (allow-list de hosts por
 * secreto, o no interpolar secretos en `url`), el cambio aplica a los dos.
 */
export class HttpAction extends PipelineActionEntry {
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

  /**
   * `{{path}}` primero (contra `event`/`steps`/`task`, mismo `getPath` que
   * usan las Condition), `${SECRETO}` DESPUÉS — en ese orden y nunca al
   * revés (ver el comentario de la clase).
   */
  private async interpolate(template: string, ctx: PipelineExecutionContext): Promise<string> {
    const root = { event: { type: ctx.event.type, payload: ctx.event.payload }, steps: ctx.steps, task: ctx.task }
    const withVars = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
      const value = Condition.getPath(root as Record<string, unknown>, path)
      return value == null ? '' : String(value)
    })

    const secretNames = [...withVars.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1])
    if (secretNames.length === 0) return withVars

    const resolver = getSecretResolver()
    if (resolver == null) {
      throw new Error(
        'HttpAction necesita un SecretResolver — ver infra/SecretResolver.js (setSecretResolver)',
      )
    }
    let result = withVars
    for (const name of secretNames) {
      const value = await resolver.resolve(name)
      if (value != null) result = result.replaceAll(`\${${name}}`, value)
    }
    return result
  }

  async run(ctx: PipelineExecutionContext): Promise<unknown> {
    const url = await this.interpolate(this.url, ctx)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.headers)) {
      headers[key] = await this.interpolate(value, ctx)
    }
    const body =
      this.body != null ? await this.interpolate(JSON.stringify(this.body), ctx) : undefined

    const controller = this.timeoutMs != null ? new AbortController() : undefined
    const timeout =
      this.timeoutMs != null ? setTimeout(() => controller?.abort(), this.timeoutMs) : undefined
    try {
      const response = await fetch(url, {
        method: this.method,
        headers,
        body,
        signal: controller?.signal,
      })
      const responseBody = await response.text()
      return { status: response.status, ok: response.ok, body: responseBody }
    } finally {
      if (timeout != null) clearTimeout(timeout)
    }
  }
}
