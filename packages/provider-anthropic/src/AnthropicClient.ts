import { type AnthropicDeltaHandler, readAnthropicSseStream } from './sse.js'

export type { AnthropicDeltaHandler, AnthropicStreamDelta } from './sse.js'

/**
 * Cliente delgado de la Anthropic Messages API: auth + headers + retry con backoff +
 * reensamblado de streaming SSE. No sabe nada de tools, agentes ni loops — es la pieza que
 * hablaría CUALQUIER caller (`AnthropicProvider`, un clasificador liviano, un script), así que
 * vive separada y se puede instanciar y usar sola. Portado de
 * `ia-flow/packages/ai-providers/src/anthropic-api/auth.ts`.
 */

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
export const ANTHROPIC_VERSION = '2023-06-01'

export interface AnthropicRetryInfo {
  /** Número de intento 1-indexado que está por hacerse (2 = primer reintento). */
  attempt: number
  maxRetries: number
  delayMs: number
  status?: number
  error?: unknown
}

export interface AnthropicContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  server_name?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

export interface AnthropicMessagesResponse {
  content: AnthropicContentBlock[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | null
  usage?: Record<string, unknown>
}

export interface AnthropicClientOptions {
  apiKey?: string
  oauthToken?: string
  fetchImpl?: typeof fetch
  anthropicVersion?: string
  /** Betas fijas de este cliente — se suman a las `extraBetas` que cada `send` agrega. */
  anthropicBeta?: string[]
  /** Reintentos DESPUÉS del primer intento. Default 0 — sin retry, salvo que `send` pase el suyo. */
  maxRetries?: number
  onRetry?: (info: AnthropicRetryInfo) => void
}

export interface AnthropicSendOptions {
  /** Default true — un request no-streaming que corre largo (thinking extendido, MCP remoto
   *  resuelto server-side) queda en una conexión inactiva y se resetea antes de que el modelo
   *  termine. Streaming mantiene bytes fluyendo. */
  stream?: boolean
  /** Betas que este request agrega condicionalmente (ej. `task-budgets-...` sólo si hay
   *  `task_budget`), sin pisar las fijas del cliente. */
  extraBetas?: string[]
  /** Override puntual de `maxRetries` para este `send`. */
  maxRetries?: number
  /** Streaming incremental: se llama con cada fragmento de texto/thinking A MEDIDA que llega
   *  (no el acumulado), antes de que el response termine de reensamblarse — es lo que le
   *  permite a un caller (ej. un chat) mostrar la respuesta escribiéndose en vivo en vez de
   *  esperar el turno completo. Ignorado si `stream` es `false` (no hay SSE del que leer
   *  deltas). El valor que `send` devuelve sigue siendo el mismo response reensamblado de
   *  siempre — `onDelta` es un canal aparte, no lo reemplaza. */
  onDelta?: AnthropicDeltaHandler
}

/** HTTP statuses que vale la pena reintentar: rate limiting y fallas transitorias upstream.
 *  400/401/403/404 son bugs de config/auth — reintentarlos sólo demora el diagnóstico. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])

/** Tope duro para un `retry-after` — un 429 de una org saturada puede pedir minutos de espera,
 *  y honrarlo tal cual retendría el run entero por todo ese tiempo. */
const MAX_RETRY_AFTER_MS = 60_000

/** Exponential backoff con jitter, respetando `retry-after` (segundos, tope MAX_RETRY_AFTER_MS)
 *  cuando el upstream lo manda. */
export function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    }
  }
  const base = Math.min(250 * 2 ** attempt, 8000)
  return base + Math.random() * base
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))
}

export class AnthropicClient {
  constructor(private readonly options: AnthropicClientOptions = {}) {}

  /** Resuelve qué credencial usar. Una credencial EXPLÍCITA (pasada en las opciones) siempre
   *  gana sobre el entorno, y sólo la del tipo explícito se considera — si pasás `apiKey` y el
   *  proceso además tiene `CLAUDE_CODE_OAUTH_TOKEN` seteado (el caso normal corriendo dentro de
   *  Claude Code), el Bearer del entorno NO debe pisar la key que pediste explícitamente. Sólo
   *  cuando NINGUNA de las dos vino explícita se cae al entorno, con el mismo orden que ia-flow
   *  (`CLAUDE_CODE_OAUTH_TOKEN` antes que `ANTHROPIC_API_KEY`). */
  private resolveAuth(): { oauthToken?: string; apiKey?: string } {
    if (this.options.oauthToken) return { oauthToken: this.options.oauthToken }
    if (this.options.apiKey) return { apiKey: this.options.apiKey }
    return {
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      apiKey: process.env.ANTHROPIC_API_KEY,
    }
  }

  private buildHeaders(extraBetas: string[]): Record<string, string> {
    const { oauthToken, apiKey } = this.resolveAuth()
    const auth: Record<string, string> = {}
    const betas = new Set<string>(this.options.anthropicBeta ?? [])
    if (oauthToken) {
      auth.Authorization = `Bearer ${oauthToken}`
      // La Messages API rechaza un Bearer OAuth sin esta beta.
      betas.add('oauth-2025-04-20')
    } else if (apiKey) {
      auth['x-api-key'] = apiKey
    } else {
      throw new Error(
        'AnthropicClient: falta credencial — pasá apiKey/oauthToken o seteá ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN',
      )
    }
    for (const beta of extraBetas) betas.add(beta)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': this.options.anthropicVersion ?? ANTHROPIC_VERSION,
      ...auth,
    }
    if (betas.size > 0) headers['anthropic-beta'] = [...betas].join(',')
    return headers
  }

  /** Un request con retry, más el reensamblado de streaming si aplica. Tira si la respuesta
   *  final (agotados los reintentos) no vino `ok`. */
  async send(
    body: Record<string, unknown>,
    opts: AnthropicSendOptions = {},
  ): Promise<AnthropicMessagesResponse> {
    const headers = this.buildHeaders(opts.extraBetas ?? [])
    const useStream = opts.stream ?? true
    const fetchImpl = this.options.fetchImpl ?? fetch
    const maxRetries = opts.maxRetries ?? this.options.maxRetries ?? 0
    const requestBody = { ...body, stream: useStream }

    const res = await this.requestWithRetry(requestBody, headers, fetchImpl, maxRetries)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`AnthropicClient: Anthropic API → ${res.status}: ${text}`)
    }
    return useStream
      ? ((await readAnthropicSseStream(res, opts.onDelta)) as unknown as AnthropicMessagesResponse)
      : ((await res.json()) as AnthropicMessagesResponse)
  }

  private async requestWithRetry(
    body: unknown,
    headers: Record<string, string>,
    fetchImpl: typeof fetch,
    maxRetries: number,
  ): Promise<Response> {
    let attempt = 0
    while (true) {
      let res: Response
      try {
        res = await fetchImpl(ANTHROPIC_API_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
      } catch (err) {
        if (attempt >= maxRetries) throw err
        const delayMs = backoffMs(attempt, null)
        this.options.onRetry?.({ attempt: attempt + 2, maxRetries, delayMs, error: err })
        await sleep(delayMs)
        attempt++
        continue
      }
      if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt >= maxRetries) return res
      const delayMs = backoffMs(attempt, res.headers.get('retry-after'))
      this.options.onRetry?.({ attempt: attempt + 2, maxRetries, delayMs, status: res.status })
      // Nadie va a leer este body — liberá la conexión antes de esperar.
      await res.body?.cancel().catch(() => {})
      await sleep(delayMs)
      attempt++
    }
  }
}
