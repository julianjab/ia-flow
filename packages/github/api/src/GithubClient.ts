import type { GithubAuth } from '@ia-flow/github-auth'
import { GithubApiError } from './GithubApiError.js'
import { type GateClock, RequestGate, realClock } from './RequestGate.js'
import { isRateLimited, isTransientStatus, rateLimitWaitMs } from './rateLimit.js'

const GITHUB_API_URL = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'

/** Cómo se reintenta un límite de tasa (o un 5xx de un request idempotente). */
export interface GithubRetryOptions {
  /** Reintentos después del primer intento. Default 3. */
  maxRetries?: number
  /** Una espera más larga que esto no se hace: el error sale como `transient` y que reintente quien
   *  lo corre (el engine), sin retener el request. Default 5 min. */
  maxWaitMs?: number
}

export interface GithubClientOptions {
  auth: GithubAuth
  fetchImpl?: typeof fetch
  retry?: GithubRetryOptions
  /** Requests en vuelo a la vez por identidad (`auth`). Default 6. */
  maxConcurrent?: number
  /** Escrituras seguidas sin esperar, por identidad. Default 10. */
  writeBurst?: number
  /** El ritmo sostenido de escrituras, por identidad: una cada tanto. Default 1000 ms (60/min,
   *  debajo de las ~80/min de contenido que tolera GitHub). */
  writeGapMs?: number
  /** El reloj de las esperas: los tests no duermen de verdad. */
  clock?: GateClock
  /** El jitter de los backoffs, en [0, 1). */
  random?: () => number
}

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MAX_WAIT_MS = 5 * 60_000
const DEFAULT_MAX_CONCURRENT = 6
const DEFAULT_WRITE_BURST = 10
const DEFAULT_WRITE_GAP_MS = 1000

/**
 * La compuerta de cada identidad, compartida por todos los `GithubClient` que la usan: el runner
 * arma varios clientes con el mismo `auth`, y el límite secundario es de la identidad, no del
 * cliente. La primera config que llega para un `auth` es la que queda.
 */
const gates = new WeakMap<GithubAuth, RequestGate>()

function gateFor(options: GithubClientOptions): RequestGate {
  let gate = gates.get(options.auth)
  if (!gate) {
    gate = new RequestGate({
      maxConcurrent: options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      writeBurst: options.writeBurst ?? DEFAULT_WRITE_BURST,
      writeGapMs: options.writeGapMs ?? DEFAULT_WRITE_GAP_MS,
      clock: options.clock ?? realClock,
    })
    gates.set(options.auth, gate)
  }
  return gate
}

/** Qué tipo de request es, para la compuerta y para saber si se puede reintentar a ciegas. */
type RequestKind = 'read' | 'write'

const MUTATION = /^\s*mutation\b/

function kindOf(init: RequestInit): RequestKind {
  const method = (init.method ?? 'GET').toUpperCase()
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write'
}

/**
 * Cliente delgado de la REST API de GitHub: resuelve el token vía `GithubAuth` (sea
 * `GithubTokenAuth` o `GithubAppAuth`, el cliente no sabe la diferencia) y arma los headers
 * estándar. No sabe nada de `Tool`s ni de agentes — es la pieza que usaría cualquier caller que
 * necesite pegarle a la API con identidad resuelta (`@ia-flow/github-tools`, un script, lo que
 * sea).
 *
 * Cuida el límite secundario de GitHub (el de ráfagas) por identidad: pocos requests a la vez, las
 * escrituras de a una y a no más de una por segundo sostenido (con ráfagas cortas), y ante un 403/429 de límite de tasa espera lo que
 * pida GitHub (o un backoff exponencial con jitter) y reintenta — y mientras tanto no sale nadie
 * más de esa identidad. Lo que igual no sale queda como `GithubApiError` con `transient`.
 */
export class GithubClient {
  private readonly gate: RequestGate

  constructor(private readonly options: GithubClientOptions) {
    this.gate = gateFor(options)
  }

  /** `path` relativo a `https://api.github.com` (ej. `/repos/o/r/issues/1`) o una URL absoluta
   *  (para seguir un `Link` header de paginación tal cual) — en los dos casos, el resultado
   *  tiene que resolver al host de la API de GitHub. Sin este chequeo, un path armado con datos
   *  de afuera (el modelo, un `Link` header manipulado) podía mandar el `Authorization: Bearer
   *  <token>` a CUALQUIER host.
   *
   *  Un límite de tasa se reintenta acá; si se agotan los intentos, devuelve la última respuesta
   *  (el 403/429) como siempre. Un fallo de red sale como `GithubApiError` `transient`. */
  request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.send(path, init, kindOf(init))
  }

  /** Como `request`, pero ya decodificado y con el 4xx/5xx convertido en excepción — el caso
   *  común de "quiero el JSON o quiero saber por qué no vino". */
  requestJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    return this.sendJson<T>(path, init, kindOf(init))
  }

  /**
   * Una query/mutation de la GraphQL API (`POST /graphql`) — hace falta para lo que la REST no
   * cubre, como los campos de un Project v2 (`Status`, `Task Type`). GraphQL responde 200 aun
   * cuando la operación falla: un `errors` no vacío también se convierte en excepción, con los
   * mensajes de GitHub, en vez de devolver un `data` a medias. Una query es una lectura (va en
   * paralelo); una mutation, una escritura (en serie).
   */
  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const body = await this.sendJson<{
      data?: T
      errors?: Array<{ message: string; type?: string }>
    }>(
      '/graphql',
      { method: 'POST', body: JSON.stringify({ query, variables }) },
      MUTATION.test(query) ? 'write' : 'read',
    )
    if (body.errors && body.errors.length > 0) {
      const message = `GithubClient: GraphQL → ${body.errors.map((error) => error.message).join('; ')}`
      // La cuota de GraphQL agotada responde 200 con `type: RATE_LIMITED`.
      const transient = body.errors.some((error) => error.type === 'RATE_LIMITED')
      throw transient ? new GithubApiError(message, { transient }) : new Error(message)
    }
    if (body.data === undefined) throw new Error('GithubClient: GraphQL respondió sin data')
    return body.data
  }

  private async sendJson<T>(path: string, init: RequestInit, kind: RequestKind): Promise<T> {
    const res = await this.send(path, init, kind)
    if (!res.ok) {
      const body = await res.text()
      const transient = isRateLimited({ status: res.status, headers: res.headers, body })
      throw new GithubApiError(`GithubClient: GitHub API → ${res.status}: ${body}`, {
        transient: transient || res.status >= 500,
        status: res.status,
        ...(transient
          ? { retryAfterMs: rateLimitWaitMs(res.headers, 1, this.clock.now(), () => 0) }
          : {}),
      })
    }
    return (await res.json()) as T
  }

  private async send(path: string, init: RequestInit, kind: RequestKind): Promise<Response> {
    const url = this.urlOf(path)
    const maxRetries = this.options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES
    const maxWaitMs = this.options.retry?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    const random = this.options.random ?? Math.random
    for (let attempt = 1; ; attempt++) {
      const res = await this.gate.run(kind === 'write', () => this.fetchOnce(url, init, kind))
      const waitMs = await this.retryWait(res, kind, attempt, random)
      if (waitMs === undefined || attempt > maxRetries || waitMs > maxWaitMs) return res
      this.gate.pause(waitMs)
    }
  }

  /** Cuánto esperar para reintentar `res`, o `undefined` si no se reintenta. */
  private async retryWait(
    res: Response,
    kind: RequestKind,
    attempt: number,
    random: () => number,
  ): Promise<number | undefined> {
    if (res.ok) return undefined
    if (res.status === 403 || res.status === 429) {
      // `clone`: quien reciba la respuesta final todavía tiene que poder leer el body.
      const body = await res.clone().text()
      if (!isRateLimited({ status: res.status, headers: res.headers, body })) return undefined
      return rateLimitWaitMs(res.headers, attempt, this.clock.now(), random)
    }
    // Un 5xx de una escritura pudo haberse aplicado: reintentarla a ciegas la duplicaría.
    if (kind === 'read' && isTransientStatus(res.status)) {
      return 1000 * 2 ** (attempt - 1) + Math.floor(random() * 500)
    }
    return undefined
  }

  private async fetchOnce(url: URL, init: RequestInit, kind: RequestKind): Promise<Response> {
    const token = await this.options.auth.getToken()
    const fetchImpl = this.options.fetchImpl ?? fetch
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    }
    try {
      return await fetchImpl(url.toString(), { ...init, headers })
    } catch (err) {
      throw new GithubApiError(
        `GithubClient: ${kind === 'write' ? 'escritura' : 'lectura'} a ${url.pathname} sin respuesta: ${(err as Error).message}`,
        { transient: true, cause: err },
      )
    }
  }

  /** La URL de `path`, que tiene que caer en la API de GitHub ANTES de adjuntar el token. */
  private urlOf(path: string): URL {
    const url = new URL(path, GITHUB_API_URL)
    if (url.origin !== GITHUB_API_URL) {
      throw new Error(`GithubClient: URL fuera de la API de GitHub: "${url}"`)
    }
    return url
  }

  private get clock(): GateClock {
    return this.options.clock ?? realClock
  }
}
