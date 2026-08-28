import { createLogger } from './logger.js'
import type { PkcePair } from './pkce.js'

const log = createLogger('figma-auth:oauth')

/** El recurso protegido. Viaja como `resource` (RFC 8707) en authorize y en
 *  token: es lo que ata el access token A ESTE MCP y no a cualquier API de
 *  Figma que comparta el mismo authorization server. */
export const FIGMA_MCP_URL = 'https://mcp.figma.com/mcp'
/** Único scope que el server publica en su metadata. */
export const FIGMA_MCP_SCOPE = 'mcp:connect'

const PROTECTED_RESOURCE_METADATA = `${FIGMA_MCP_URL.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource`

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface AuthServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  scopes_supported?: string[]
}

export interface OAuthClient {
  clientId: string
  /** Ausente = cliente público (sólo PKCE). El registro dinámico de Figma
   *  puede devolver secret o no; las dos formas se soportan. */
  clientSecret?: string
}

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  /** Epoch ms. `undefined` = el AS no dijo cuándo vence, así que el token se
   *  usa hasta que el server lo rechace. */
  expiresAt?: number
  scope?: string
  tokenType: string
}

export interface OAuthDeps {
  fetch?: FetchLike
  now?: () => number
}

const resolveDeps = (deps: OAuthDeps = {}) => ({
  doFetch: deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init)),
  now: deps.now ?? (() => Date.now()),
})

/**
 * Descubrimiento en dos saltos, que es el que define el spec de MCP: el
 * recurso dice quién lo autoriza, y recién ahí se le pide su metadata.
 *
 * Hardcodear `https://api.figma.com` funcionaría hoy y se rompería en
 * silencio el día que Figma mueva su AS — y el 401 del MCP ya trae el puntero
 * al metadata en `WWW-Authenticate`, así que seguirlo es gratis.
 */
export async function discoverAuthServer(deps: OAuthDeps = {}): Promise<AuthServerMetadata> {
  const { doFetch } = resolveDeps(deps)

  const resourceRes = await doFetch(PROTECTED_RESOURCE_METADATA)
  if (!resourceRes.ok) {
    throw new Error(
      `No se pudo leer el metadata de ${FIGMA_MCP_URL} (${resourceRes.status}). ` +
        '¿El MCP de Figma cambió de URL?',
    )
  }
  const resource = (await resourceRes.json()) as { authorization_servers?: string[] }
  const issuer = resource.authorization_servers?.[0]
  if (!issuer) {
    throw new Error('El metadata del MCP de Figma no declara ningún authorization server')
  }

  const metadataUrl = `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`
  const asRes = await doFetch(metadataUrl)
  if (!asRes.ok) {
    throw new Error(`No se pudo leer el metadata de ${issuer} (${asRes.status})`)
  }
  const metadata = (await asRes.json()) as AuthServerMetadata
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error(`El metadata de ${issuer} no trae authorization_endpoint y token_endpoint`)
  }

  // No hay fallback a `plain`: si el AS dejara de soportar S256, seguir sin
  // PKCE convertiría el code interceptado en un token. Preferimos fallar.
  const methods = metadata.code_challenge_methods_supported
  if (methods && !methods.includes('S256')) {
    throw new Error(
      `El authorization server de Figma ya no soporta PKCE S256 (${methods.join(', ')})`,
    )
  }

  log.debug(
    { issuer, endpoint: metadata.authorization_endpoint },
    'authorization server descubierto',
  )
  return metadata
}

/**
 * Registro dinámico (RFC 7591). Es lo que evita que el operador tenga que
 * crear una app OAuth a mano en Figma antes de poder loguearse.
 *
 * Si el endpoint no existe o lo rechaza, el error dice cuál es la salida
 * manual — un `client_id` propio — en vez de dejar al operador con un 403 sin
 * contexto.
 */
export async function registerClient(
  opts: { metadata: AuthServerMetadata; redirectUri: string; clientName?: string },
  deps: OAuthDeps = {},
): Promise<OAuthClient> {
  const { doFetch } = resolveDeps(deps)
  const endpoint = opts.metadata.registration_endpoint
  if (!endpoint) {
    throw new Error(
      'El authorization server de Figma no ofrece registro dinámico. ' +
        'Creá una app OAuth en Figma y pasá su client id con --client-id (o FIGMA_OAUTH_CLIENT_ID).',
    )
  }

  const res = await doFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: opts.clientName ?? 'ia-flow',
      redirect_uris: [opts.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: FIGMA_MCP_SCOPE,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `Figma rechazó el registro dinámico (${res.status}: ${body.slice(0, 200)}). ` +
        'Creá una app OAuth en Figma con el redirect ' +
        `${opts.redirectUri} y pasá su client id con --client-id (o FIGMA_OAUTH_CLIENT_ID).`,
    )
  }

  const body = (await res.json()) as { client_id?: string; client_secret?: string }
  if (!body.client_id) throw new Error('El registro dinámico no devolvió client_id')
  log.info({ clientId: body.client_id, public: !body.client_secret }, 'cliente OAuth registrado')
  return { clientId: body.client_id, clientSecret: body.client_secret }
}

export function buildAuthorizationUrl(opts: {
  metadata: AuthServerMetadata
  client: OAuthClient
  redirectUri: string
  pkce: PkcePair
  state: string
  scope?: string
}): string {
  const url = new URL(opts.metadata.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', opts.client.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('scope', opts.scope ?? FIGMA_MCP_SCOPE)
  url.searchParams.set('state', opts.state)
  url.searchParams.set('code_challenge', opts.pkce.challenge)
  url.searchParams.set('code_challenge_method', opts.pkce.method)
  url.searchParams.set('resource', FIGMA_MCP_URL)
  return url.toString()
}

export async function exchangeCode(
  opts: {
    metadata: AuthServerMetadata
    client: OAuthClient
    redirectUri: string
    code: string
    verifier: string
  },
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
    resource: FIGMA_MCP_URL,
  })
  return tokenRequest(opts.metadata, opts.client, params, deps)
}

/**
 * Renovación. Devuelve el refresh token viejo cuando el AS no manda uno nuevo:
 * la respuesta de refresh puede omitirlo (RFC 6749 §5.1 lo declara opcional) y
 * pisarlo con `undefined` dejaría la sesión sin forma de renovarse otra vez —
 * el token siguiente vencería y habría que re-loguearse a mano.
 */
export async function refreshAccessToken(
  opts: { metadata: AuthServerMetadata; client: OAuthClient; refreshToken: string },
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    resource: FIGMA_MCP_URL,
  })
  const tokens = await tokenRequest(opts.metadata, opts.client, params, deps)
  return { ...tokens, refreshToken: tokens.refreshToken ?? opts.refreshToken }
}

async function tokenRequest(
  metadata: AuthServerMetadata,
  client: OAuthClient,
  params: URLSearchParams,
  deps: OAuthDeps,
): Promise<TokenSet> {
  const { doFetch, now } = resolveDeps(deps)

  // `client_secret_post`: es uno de los dos métodos que Figma publica y el
  // único que funciona igual con y sin secret (un cliente público manda sólo
  // el client_id, sin header de auth que armar).
  params.set('client_id', client.clientId)
  if (client.clientSecret) params.set('client_secret', client.clientSecret)

  const res = await doFetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `${metadata.token_endpoint} → ${res.status}: ${body.slice(0, 300)} ` +
        `(grant_type=${params.get('grant_type')})`,
    )
  }

  const body = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    token_type?: string
  }
  if (!body.access_token) {
    throw new Error(`${metadata.token_endpoint} devolvió 200 sin access_token`)
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: typeof body.expires_in === 'number' ? now() + body.expires_in * 1000 : undefined,
    scope: body.scope,
    tokenType: body.token_type ?? 'Bearer',
  }
}
