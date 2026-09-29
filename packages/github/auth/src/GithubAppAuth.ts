import { createSign } from 'node:crypto'
import type { GithubAuth } from './GithubAuth.js'

const GITHUB_API_URL = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'
/** Tope de GitHub para el JWT del App — 10 minutos. Usamos 9 para dejar margen de reloj. */
const APP_JWT_TTL_SECONDS = 9 * 60
/** Tolerancia de reloj hacia atrás — un `iat` en el futuro (reloj local adelantado) hace que
 *  GitHub rechace el JWT con "not yet valid". */
const CLOCK_SKEW_SECONDS = 60

export interface GithubAppAuthOptions {
  appId: string
  installationId: string
  /** Contenido PEM completo — leerlo de disco/Secret es responsabilidad del caller, esta clase
   *  nunca toca el filesystem. */
  privateKey: string
  fetchImpl?: typeof fetch
  /** Margen antes de que venza el installation token para refrescarlo en vez de esperar a que
   *  falle un request en el medio de un request más grande. Default 5 minutos. */
  refreshMarginMs?: number
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

/** Arma y firma el JWT del App (RS256) — sin dependencias externas, `node:crypto` alcanza. */
function buildAppJwt(appId: string, privateKeyPem: string, now: number): string {
  const iat = Math.floor(now / 1000) - CLOCK_SKEW_SECONDS
  const exp = iat + CLOCK_SKEW_SECONDS + APP_JWT_TTL_SECONDS
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ iat, exp, iss: appId }))
  const signingInput = `${header}.${payload}`
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .end()
    .sign(privateKeyPem, 'base64url')
  return `${signingInput}.${signature}`
}

interface CachedToken {
  token: string
  expiresAt: number
}

/**
 * Login de GITHUB APP — JWT firmado con el PEM del App, intercambiado por un installation
 * token (`POST /app/installations/:id/access_tokens`). El token vive ~1h; esta clase lo
 * cachea y lo refresca sola antes de que venza (nunca se captura y se reusa a ciegas, mismo
 * criterio que ia-flow: "el token se resuelve por uso").
 */
export class GithubAppAuth implements GithubAuth {
  private cached: CachedToken | undefined

  constructor(private readonly options: GithubAppAuthOptions) {}

  async getToken(now: number = Date.now()): Promise<string> {
    const refreshMargin = this.options.refreshMarginMs ?? 5 * 60_000
    if (this.cached && this.cached.expiresAt - refreshMargin > now) {
      return this.cached.token
    }

    const jwt = buildAppJwt(this.options.appId, this.options.privateKey, now)
    const fetchImpl = this.options.fetchImpl ?? fetch
    const res = await fetchImpl(
      `${GITHUB_API_URL}/app/installations/${this.options.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
      },
    )
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`GithubAppAuth: GitHub API → ${res.status}: ${body}`)
    }
    const data = (await res.json()) as { token: string; expires_at: string }
    this.cached = { token: data.token, expiresAt: new Date(data.expires_at).getTime() }
    return data.token
  }
}
