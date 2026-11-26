/**
 * El login de cada persona en la web con su cuenta de GitHub (device flow de la GitHub App): la
 * web muestra un código, la persona lo aprueba en github.com y el token que vuelve firma sus
 * movimientos en el board. El runner sólo intermedia — GitHub no habla CORS en estos endpoints — y
 * nunca guarda el token. Un token de device flow se renueva sin `client_secret` (`refresh`): la web
 * guarda el `refresh_token` y lo cambia antes de que venza.
 */
import { createHash } from 'node:crypto'
import type { DeviceCode, DevicePoll, GithubUserToken } from '@ia-flow/shared'
import { createLogger } from '@ia-flow/telemetry'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * Cuánto se recuerda una renovación. GitHub invalida el `refresh_token` apenas lo canjea: si la
 * respuesta no llega al cliente (timeout, la Mac que despierta, el pod que se reinicia), su
 * reintento llega con el viejo y GitHub lo rechazaría. Dentro de esta ventana recibe el mismo par.
 */
export const REFRESH_REPLAY_MS = 10 * 60_000

/** GitHub rechazó el `refresh_token` (vencido, ya usado o revocado): hay que volver a loguearse. */
export class RefreshRejectedError extends Error {}

export interface DeviceFlowOptions {
  /** El client id (`github.clientId` / IA_FLOW_GITHUB_CLIENT_ID): de una GitHub App o de una OAuth App. */
  clientId: string
  /** Los scopes (`github.scopes` / IA_FLOW_GITHUB_SCOPES), separados por espacio. Una OAuth App sin
   *  scopes da un token que sólo lee lo público; una GitHub App los ignora. */
  scopes?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`GitHub ${url} → ${res.status}: ${await res.text()}`)
  return (await res.json()) as Record<string, unknown>
}

/** La clave del memo: el hash, para no tener tokens en claro en memoria más de lo necesario. */
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

export class DeviceFlow {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly log = createLogger('runner.github-login')
  /** Los canjes recientes (y los en curso) por hash del `refresh_token` canjeado. */
  private readonly renewals = new Map<
    string,
    { at: number; grant: Promise<Record<string, unknown>> }
  >()

  constructor(private readonly options: DeviceFlowOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  async start(): Promise<DeviceCode> {
    const scope = this.options.scopes?.trim()
    const data = await postForm(this.fetchImpl, DEVICE_CODE_URL, {
      client_id: this.options.clientId,
      ...(scope ? { scope } : {}),
    })
    if (typeof data.device_code !== 'string') {
      throw new Error(`GitHub no devolvió un device code: ${JSON.stringify(data)}`)
    }
    return {
      device_code: data.device_code,
      user_code: String(data.user_code),
      verification_uri: String(data.verification_uri),
      expires_in: Number(data.expires_in),
      interval: Number(data.interval ?? 5),
    }
  }

  /** Una vuelta de la espera: `pending` hasta que la persona apruebe el código. */
  async poll(deviceCode: string): Promise<DevicePoll> {
    const data = await postForm(this.fetchImpl, ACCESS_TOKEN_URL, {
      client_id: this.options.clientId,
      device_code: deviceCode,
      grant_type: GRANT_TYPE,
    })
    if (typeof data.access_token === 'string') {
      return { status: 'ok', ...(await this.userToken(data, data.access_token)) }
    }
    switch (data.error) {
      case 'authorization_pending':
        return { status: 'pending' }
      case 'slow_down':
        return { status: 'slow_down' }
      case 'expired_token':
        return { status: 'expired' }
      case 'access_denied':
        return { status: 'denied' }
      default:
        throw new Error(
          `GitHub rechazó el device code: ${String(data.error_description ?? data.error)}`,
        )
    }
  }

  /**
   * Un token nuevo a cambio del `refresh_token`; GitHub rota los dos. El mismo `refresh_token`
   * dentro de `REFRESH_REPLAY_MS` (o mientras se canjea) reusa el canje, sin volver a GitHub.
   */
  async refresh(refreshToken: string): Promise<GithubUserToken> {
    const data = await this.exchange(refreshToken)
    return this.userToken(data, data.access_token as string)
  }

  /** El canje en GitHub, recordado: sólo uno que salió bien, un error se puede reintentar. */
  private exchange(refreshToken: string): Promise<Record<string, unknown>> {
    const now = this.now()
    for (const [key, renewal] of this.renewals) {
      if (now - renewal.at > REFRESH_REPLAY_MS) this.renewals.delete(key)
    }
    const key = digest(refreshToken)
    const known = this.renewals.get(key)
    if (known) {
      this.log.info('renovación repetida: se reusa el canje anterior')
      return known.grant
    }
    const grant = this.grant(refreshToken)
    this.renewals.set(key, { at: now, grant })
    grant.catch(() => this.renewals.delete(key))
    return grant
  }

  private async grant(refreshToken: string): Promise<Record<string, unknown>> {
    const data = await postForm(this.fetchImpl, ACCESS_TOKEN_URL, {
      client_id: this.options.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
    if (typeof data.access_token !== 'string') {
      const code = String(data.error ?? 'sin código')
      this.log.warn(`GitHub rechazó la renovación: ${code}`, {
        error: code,
        error_description: String(data.error_description ?? ''),
      })
      throw new RefreshRejectedError(
        `GitHub no renovó el token: ${String(data.error_description ?? data.error ?? 'sin motivo')}`,
      )
    }
    return data
  }

  login(token: string): Promise<string> {
    return githubLogin(token, this.fetchImpl)
  }

  /** El token con su login y, si GitHub los mandó, cómo y cuándo renovarlo. */
  private async userToken(
    data: Record<string, unknown>,
    accessToken: string,
  ): Promise<GithubUserToken> {
    const seconds = (value: unknown) => (typeof value === 'number' ? value : undefined)
    const expiresIn = seconds(data.expires_in)
    const refreshExpiresIn = seconds(data.refresh_token_expires_in)
    return {
      access_token: accessToken,
      login: await this.login(accessToken),
      ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
      ...(typeof data.refresh_token === 'string' ? { refresh_token: data.refresh_token } : {}),
      ...(refreshExpiresIn !== undefined ? { refresh_token_expires_in: refreshExpiresIn } : {}),
    }
  }
}

/** De quién es un token de GitHub (lo que se muestra y queda en el registro de acciones). */
export async function githubLogin(token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(USER_URL, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  })
  if (!res.ok) throw new Error(`el token de GitHub no sirve (${res.status})`)
  const user = (await res.json()) as { login?: string }
  if (!user.login) throw new Error('GitHub no devolvió el login del token')
  return user.login
}
