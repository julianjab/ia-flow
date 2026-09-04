// GitHub GraphQL client — thin wrapper around fetch, no extra deps

import { createLogger } from '../logger.js'
import { getGitHubToken } from './credentials.js'
import {
  type RateLimitResource,
  getRateLimit,
  markRateLimited,
  updateFromHeaders,
} from './rate-limit.js'

const log = createLogger('github-client')

// e.g. "query ProjectItems(" / "mutation UpdateItemStatus(" → "ProjectItems"
function operationName(query: string): string {
  const m = query.match(/(?:query|mutation)\s+(\w+)/)
  return m?.[1] ?? 'anonymous'
}

// Un request de GitHub por línea de `info` era el 75% del daemon.log: es
// tráfico de polling, constante y sin novedad. El detalle completo sigue
// estando, en `debug`; en `info` queda sólo lo que un operador necesita ver
// sin salir a buscarlo — un request que falló, o la cuota tocando el piso.
const QUOTA_FLOOR_RATIO = 0.1

const belowQuotaFloor: Partial<Record<RateLimitResource, boolean>> = {}

/**
 * Exportada por su test: es el estado que decide entre `info` y `debug` para
 * cada request, y su punto entero está en la transición — un test que sólo
 * mirara una llamada no distinguiría esta implementación de un `remaining <=
 * piso` a secas, que es justo el ruido que había que sacar.
 *
 * `true` sólo en la TRANSICIÓN hacia el piso de cuota, no mientras se está
 * debajo: avisar en cada request mientras la ventana está baja sería
 * exactamente el ruido que este cambio saca, y encima concentrado en el peor
 * momento. Se rearma solo cuando la ventana se renueva y `remaining` vuelve
 * a subir.
 */
export function crossedQuotaFloor(resource: RateLimitResource, headers: Headers): boolean {
  const remaining = Number(headers.get('x-ratelimit-remaining'))
  const limit = Number(headers.get('x-ratelimit-limit'))
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return false
  const low = remaining <= limit * QUOTA_FLOOR_RATIO
  const crossed = low && !belowQuotaFloor[resource]
  belowQuotaFloor[resource] = low
  return crossed
}

/** Un request normal va a `debug`; uno que falló o que cruzó el piso de
 *  cuota, a `info`. Los campos son los mismos en los dos casos. */
function logRequest(
  resource: RateLimitResource,
  res: Response,
  fields: Record<string, unknown>,
  msg: string,
): void {
  // Fuera del `||` a propósito: el short-circuit se saltearía la
  // actualización del estado del piso en cada respuesta con error.
  const crossed = crossedQuotaFloor(resource, res.headers)
  log[!res.ok || crossed ? 'info' : 'debug'](fields, msg)
}

export interface GQLError {
  message: string
  /** GitHub's machine-readable code — `NOT_FOUND`, `FORBIDDEN`, … Ausente en
   *  los errores de validación de la query (esos traen sólo `message`). */
  type?: string
  path?: Array<string | number>
}

export interface GQLResponse<T> {
  data: T
  errors?: GQLError[]
}

/**
 * Los errores de GraphQL, preservados como datos.
 *
 * `gql` lanza ante cualquier `errors[]`, y aplastarlos a un `join('; ')`
 * obligaba a quien quisiera distinguir un caso del otro a matchear el texto
 * del mensaje. El caso que lo motivó: GitHub NO devuelve `data.node = null`
 * para un node id que ya no existe — devuelve un error top-level `NOT_FOUND`,
 * así que un item borrado del board llegaba como excepción a callers cuyo
 * contrato es devolver `null` (ver `isNodeNotFoundError`).
 */
export class GitHubGraphQLError extends Error {
  constructor(
    message: string,
    public readonly errors: GQLError[],
  ) {
    super(message)
    this.name = 'GitHubGraphQLError'
  }
}

/**
 * True cuando el ÚNICO problema fue que el node no existe — el id se borró,
 * o nunca fue de este tipo. Un caller cuyo contrato es `Promise<T | null>`
 * lo traduce a `null`; cualquier otra mezcla de errores (permisos, rate
 * limit, una query inválida) sigue siendo una excepción, porque ahí la
 * respuesta correcta no es "no existe" sino "no sé".
 *
 * Se chequea `type` Y el texto: los errores de `node(id:)` traen
 * `type: 'NOT_FOUND'`, pero un id con formato de otro objeto puede volver
 * sólo con el mensaje.
 */
export function isNodeNotFoundError(err: unknown): boolean {
  if (!(err instanceof GitHubGraphQLError) || err.errors.length === 0) return false
  return err.errors.every(
    (e) => e.type === 'NOT_FOUND' || /could not resolve to a[n]? /i.test(e.message),
  )
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public resource: RateLimitResource,
    public resetAt: number | null,
  ) {
    super(message)
    this.name = 'RateLimitError'
  }
}

// Fail fast when we already know the window is exhausted — no point burning
// another request that will come back with the same error.
function guardBeforeCall(resource: RateLimitResource) {
  const snap = getRateLimit()
  if (snap.limited && snap.resource === resource) {
    throw new RateLimitError(
      snap.message ?? `GitHub ${resource} rate limit exhausted`,
      resource,
      snap.resetAt,
    )
  }
}

function looksLikeRateLimit(msg: string): boolean {
  const m = msg.toLowerCase()
  return m.includes('rate limit') || m.includes('secondary rate') || m.includes('abuse detection')
}

export async function gql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const token = await getGitHubToken()
  if (!token)
    throw new Error('No hay credencial de GitHub configurada (ver IA_FLOW_GITHUB_AUTH_MODE)')

  guardBeforeCall('graphql')

  const op = operationName(query)
  const startedAt = performance.now()
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ia-flow/1.0',
    },
    body: JSON.stringify({ query, variables }),
  })

  updateFromHeaders(res.headers, 'graphql')
  logRequest(
    'graphql',
    res,
    {
      op,
      variables,
      status: res.status,
      durationMs: Math.round(performance.now() - startedAt),
      remaining: res.headers.get('x-ratelimit-remaining'),
      limit: res.headers.get('x-ratelimit-limit'),
    },
    `github graphql ${op}`,
  )

  if (!res.ok) {
    const text = await res.text()
    if (res.status === 403 || res.status === 429 || looksLikeRateLimit(text)) {
      const reset = Number.parseInt(res.headers.get('x-ratelimit-reset') ?? '', 10)
      markRateLimited(
        'graphql',
        text || `HTTP ${res.status}`,
        Number.isFinite(reset) ? reset : null,
      )
    }
    throw new Error(`GitHub API HTTP ${res.status}: ${text}`)
  }

  const json = (await res.json()) as GQLResponse<T>
  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join('; ')
    if (looksLikeRateLimit(msg)) {
      const reset = Number.parseInt(res.headers.get('x-ratelimit-reset') ?? '', 10)
      markRateLimited('graphql', msg, Number.isFinite(reset) ? reset : null)
    }
    throw new GitHubGraphQLError(`GitHub GraphQL errors: ${msg}`, json.errors)
  }

  return json.data
}

// GitHub REST client for simple operations
export async function rest(
  path: string,
  options: {
    method?: string
    body?: unknown
    // Override del media type — p. ej. `application/vnd.github.v3.diff` para
    // pedir el diff unificado de un PR en vez de su representación JSON.
    accept?: string
    // `true` ⇒ devuelve el body crudo (`res.text()`) en vez de parsearlo como
    // JSON — necesario para `accept` no-JSON como el de arriba.
    raw?: boolean
  } = {},
): Promise<unknown> {
  const token = await getGitHubToken()
  if (!token)
    throw new Error('No hay credencial de GitHub configurada (ver IA_FLOW_GITHUB_AUTH_MODE)')

  guardBeforeCall('rest')

  const startedAt = performance.now()
  const res = await fetch(`https://api.github.com${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: options.accept ?? 'application/vnd.github+json',
      'User-Agent': 'ia-flow/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  updateFromHeaders(res.headers, 'rest')
  logRequest(
    'rest',
    res,
    {
      method: options.method ?? 'GET',
      path,
      status: res.status,
      durationMs: Math.round(performance.now() - startedAt),
      remaining: res.headers.get('x-ratelimit-remaining'),
      limit: res.headers.get('x-ratelimit-limit'),
    },
    `github rest ${options.method ?? 'GET'} ${path}`,
  )

  if (!res.ok) {
    const text = await res.text()
    if (res.status === 403 || res.status === 429 || looksLikeRateLimit(text)) {
      const reset = Number.parseInt(res.headers.get('x-ratelimit-reset') ?? '', 10)
      markRateLimited('rest', text || `HTTP ${res.status}`, Number.isFinite(reset) ? reset : null)
    }
    throw new Error(`GitHub REST ${options.method ?? 'GET'} ${path} → ${res.status}: ${text}`)
  }

  return options.raw ? res.text() : res.json()
}
