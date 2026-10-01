import type { ToolInputSchema } from '../../agent/SchemaTool.js'
import { type PipelineExecutionContext, Runnable, type RunnableProps } from '../Runnable.js'

const BODYLESS_METHODS = new Set(['GET', 'DELETE'])

type StepInput = Record<string, unknown> | undefined
/** Lo que se serializa como JSON. Acotado (no `unknown`) para que una función `body` tipe sus
 *  parámetros sola: `unknown | Función` colapsa a `unknown` y TS pierde el contexto. */
type JsonBody = string | number | boolean | null | Record<string, unknown> | unknown[]

export interface HttpActionProps extends RunnableProps {
  url: string | ((ctx: PipelineExecutionContext, input: StepInput) => string)
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Una función puede ser async: una credencial que vence se pide en cada request. */
  headers?:
    | Record<string, string>
    | ((
        ctx: PipelineExecutionContext,
        input: StepInput,
      ) => Record<string, string> | Promise<Record<string, string>>)
  /** Sin `body`, el input validado (si hay) ES el body. */
  body?: JsonBody | ((ctx: PipelineExecutionContext, input: StepInput) => unknown)
  /** Opcional: qué puede entregarle un agente a este paso como destino de una ruta. */
  input?: ToolInputSchema
  /** Corta la request si no responde a tiempo — un host colgado, si no, bloquea el Pipeline
   *  para siempre. Default 30s. */
  timeoutMs?: number
  /** Default: el `fetch` global. */
  fetch?: typeof fetch
}

/**
 * `HttpAction.url` resuelve contra el host que le pases, sin sustitución de secretos en la
 * URL — a diferencia de `HttpAction.url` de engine-v2 (que interpola `${SECRETO}` sin
 * allow-list de destino, un riesgo documentado en su README). Acá cualquier secreto va en
 * `headers`/`body` ya resuelto por quien arma el Pipeline, nunca parseado desde un string de
 * config — así no hay superficie para mandar un token a una URL arbitraria por config mal
 * escrita.
 */
export class HttpAction extends Runnable {
  readonly url: HttpActionProps['url']
  readonly method: NonNullable<HttpActionProps['method']>
  readonly headers?: HttpActionProps['headers']
  readonly body?: HttpActionProps['body']
  readonly timeoutMs: number
  readonly input?: ToolInputSchema
  private readonly fetchImpl?: typeof fetch

  constructor(props: HttpActionProps) {
    super(props)
    this.url = props.url
    this.method = props.method ?? 'GET'
    this.headers = props.headers
    this.body = props.body
    this.timeoutMs = props.timeoutMs ?? 30_000
    this.input = props.input
    this.fetchImpl = props.fetch
  }

  override acceptsInput(): ToolInputSchema | undefined {
    return this.input
  }

  async run(ctx: PipelineExecutionContext, input?: unknown): Promise<unknown> {
    const parsed = this.parseInput(this.input, input)
    const url = typeof this.url === 'function' ? this.url(ctx, parsed) : this.url
    const headers =
      typeof this.headers === 'function' ? await this.headers(ctx, parsed) : this.headers
    const body = typeof this.body === 'function' ? this.body(ctx, parsed) : (this.body ?? parsed)

    // `fetch` tira TypeError si un método sin cuerpo (GET/DELETE) lleva `body` — así que acá
    // se omite en vez de dejar que el `body` de la config rompa la request entera.
    const requestBody =
      body != null && !BODYLESS_METHODS.has(this.method) ? JSON.stringify(body) : undefined

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    let contentType: string
    let raw: string
    try {
      // El `finally` de abajo tiene que envolver TAMBIÉN `response.text()`, no sólo el
      // `fetch` — el `AbortController` recién frena la conexión mientras está activo, y
      // `fetch` resuelve en cuanto llegan los headers. Un servidor que manda los headers
      // rápido pero el body nunca (o muy lento) dejaba la lectura del body sin ningún límite
      // de tiempo si el timeout se cancelaba antes, justo lo que `timeoutMs` dice que evita.
      const response = await (this.fetchImpl ?? fetch)(url, {
        method: this.method,
        headers: { 'content-type': 'application/json', ...headers },
        body: requestBody,
        signal: controller.signal,
      })
      contentType = response.headers.get('content-type') ?? ''
      // Se lee SIEMPRE como texto primero, nunca `response.json()` directo: un 5xx con
      // `content-type: application/json` pero body vacío o HTML (un proxy, un balanceador)
      // tira un SyntaxError que tapa el status real detrás de un error de parseo confuso. Leer
      // texto primero también cubre un 204 (body vacío) sin que `JSON.parse('')` explote.
      raw = await response.text()
      if (!response.ok) {
        const snippet = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw
        throw new Error(
          `HttpAction: ${this.method} ${url} → ${response.status}${snippet ? `: ${snippet}` : ''}`,
        )
      }
    } finally {
      clearTimeout(timeout)
    }

    if (raw === '') return undefined
    return contentType.includes('application/json') ? JSON.parse(raw) : raw
  }
}
