import { createSign } from 'node:crypto'
import type { CredentialDescription, ICredentialProvider } from '@ia-flow/shared'
import { createLogger } from './logger.js'

const log = createLogger('github-auth:app')

/** Margen con el que consideramos vencido un installation token. GitHub los
 *  emite a 60'; renovar 5' antes cubre el clock skew y un run largo que agarró
 *  el token justo antes del filo. */
const RENEW_MARGIN_MS = 5 * 60_000
/** Vida del JWT de app. El máximo que GitHub acepta son 10'; 9' deja aire para
 *  relojes desincronizados sin que la request se rechace por `exp` futuro. */
const JWT_TTL_S = 9 * 60
/** GitHub rechaza un JWT con `iat` en el futuro. Un minuto atrás es el
 *  antídoto estándar contra el reloj del host adelantado. */
const JWT_BACKDATE_S = 60

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

interface CachedToken {
  token: string
  expiresAt: number
}

/**
 * PEM tal como sale de GitHub, tal como sobrevive a un `.env`, o en base64.
 *
 * Las tres formas existen en la práctica: el `.pem` descargado tiene saltos de
 * línea reales, un `.env` los convierte en `\n` literales, y quien mete la key
 * en un secret manager suele base64-earla para no pelear con el escaping. Si
 * no normalizamos acá, el error aparece recién en `createSign` como un
 * "error:1E08010C:DECODER routines::unsupported", que no le dice nada a nadie.
 */
export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.includes('-----BEGIN')) return trimmed.replace(/\\n/g, '\n')
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8')
  if (decoded.includes('-----BEGIN')) return decoded.trim().replace(/\\n/g, '\n')
  throw new Error(
    'IA_FLOW_GITHUB_APP_PRIVATE_KEY no parece un PEM (ni crudo ni base64). ' +
      'Esperado el contenido del .pem que descargaste de la GitHub App.',
  )
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** JWT RS256 firmado con la private key de la app. Es la credencial que sólo
 *  sirve para hablar de la app en sí (`/app/**`), no para tocar repos. */
export function signAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - JWT_BACKDATE_S
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iat, exp: iat + JWT_TTL_S, iss: appId }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`
}

/**
 * Identidad de GitHub App: el server firma un JWT con la private key, lo
 * cambia por un **installation token** de una hora, y lo renueva solo.
 *
 * Es el modo pensado para el daemon: la identidad es `<app>[bot]` en vez de
 * una persona, el rate limit es propio de la instalación (no compartido con
 * lo que el humano haga en su sesión), los permisos son auditables por repo, y
 * revocar la instalación corta todo de una sin rotar secretos en otro lado.
 *
 * El token que devuelve sirve igual para la API y para git — GitHub acepta
 * un installation token como password de `x-access-token`, que es exactamente
 * el formato que `WorkspaceManager` ya usaba con el PAT.
 */
export class GitHubAppCredentials implements ICredentialProvider {
  readonly #appId: string
  readonly #privateKey: string
  readonly #defaultInstallationId: string | undefined
  readonly #fetch: FetchLike
  readonly #now: () => number

  /** Un token por instalación: una app instalada en dos orgs tiene dos
   *  credenciales distintas y mezclarlas da 404 silenciosos. */
  readonly #cache = new Map<string, CachedToken>()
  /** Renovaciones en vuelo, para que N runs que arrancan a la vez pidan UN
   *  token y no N. Misma idea que el dedupe de `@memoize`. */
  readonly #inflight = new Map<string, Promise<string>>()
  /** `owner/repo` → installationId ya resuelto. La instalación de un repo no
   *  cambia salvo que alguien la desinstale, así que no lleva TTL. */
  readonly #installationByRepo = new Map<string, string>()

  constructor(opts: {
    appId: string
    privateKey: string
    installationId?: string
    fetch?: FetchLike
    now?: () => number
  }) {
    this.#appId = opts.appId
    this.#privateKey = normalizePrivateKey(opts.privateKey)
    this.#defaultInstallationId = opts.installationId
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init))
    this.#now = opts.now ?? (() => Date.now())
  }

  async getToken(scope?: { owner?: string; repo?: string }): Promise<string | undefined> {
    const installationId = await this.#resolveInstallationId(scope)
    const cached = this.#cache.get(installationId)
    if (cached && cached.expiresAt - RENEW_MARGIN_MS > this.#now()) return cached.token

    const pending = this.#inflight.get(installationId)
    if (pending) return pending

    const promise = this.#mint(installationId).finally(() => {
      this.#inflight.delete(installationId)
    })
    this.#inflight.set(installationId, promise)
    return promise
  }

  describe(): CredentialDescription {
    return { mode: 'github-app', identity: `app:${this.#appId}` }
  }

  async #mint(installationId: string): Promise<string> {
    const res = await this.#appRequest(`/app/installations/${installationId}/access_tokens`, 'POST')
    const body = (await res.json()) as { token?: string; expires_at?: string }
    if (!body.token) throw new Error('GitHub no devolvió token en el access_tokens de la app')
    const expiresAt = body.expires_at ? Date.parse(body.expires_at) : this.#now() + 60 * 60_000
    this.#cache.set(installationId, { token: body.token, expiresAt })
    log.info(
      { appId: this.#appId, installationId, expiresAt: body.expires_at },
      'installation token renovado',
    )
    return body.token
  }

  /**
   * Tres caminos, del más barato al más caro: el id configurado, el de la
   * instalación que cubre ese repo, o —si la app está instalada en un solo
   * lado— el único que existe. El último evita tener que configurar un
   * `installationId` a mano en el caso de una sola org, que es el 90% de los
   * setups.
   */
  async #resolveInstallationId(scope?: { owner?: string; repo?: string }): Promise<string> {
    if (scope?.owner && scope.repo) {
      const key = `${scope.owner}/${scope.repo}`
      const known = this.#installationByRepo.get(key)
      if (known) return known
      const res = await this.#appRequest(`/repos/${key}/installation`, 'GET')
      const body = (await res.json()) as { id?: number }
      if (body.id) {
        const id = String(body.id)
        this.#installationByRepo.set(key, id)
        return id
      }
    }

    if (this.#defaultInstallationId) return this.#defaultInstallationId

    const res = await this.#appRequest('/app/installations', 'GET')
    const list = (await res.json()) as Array<{ id: number; account?: { login?: string } }>
    if (list.length === 1) return String(list[0].id)
    if (list.length === 0)
      throw new Error(
        `La GitHub App ${this.#appId} no está instalada en ninguna cuenta. Instalala en la org y reintentá.`,
      )
    throw new Error(
      `La GitHub App ${this.#appId} está instalada en ${list.length} cuentas ` +
        `(${list.map((i) => i.account?.login ?? i.id).join(', ')}). ` +
        'Configurá IA_FLOW_GITHUB_APP_INSTALLATION_ID para elegir una.',
    )
  }

  async #appRequest(path: string, method: string): Promise<Response> {
    const jwt = signAppJwt(this.#appId, this.#privateKey, this.#now())
    const res = await this.#fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ia-flow/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub App ${method} ${path} → ${res.status}: ${text}`)
    }
    return res
  }
}
