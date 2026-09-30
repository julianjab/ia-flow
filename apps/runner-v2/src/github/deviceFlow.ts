/**
 * El login de cada persona en la web con su cuenta de GitHub (device flow de la GitHub App): la
 * web muestra un código, la persona lo aprueba en github.com y el token que vuelve firma sus
 * movimientos en el board. El runner sólo intermedia — GitHub no habla CORS en estos endpoints — y
 * nunca guarda el token.
 */
import type { DeviceCode, DevicePoll } from '@ia-flow/shared'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

export interface DeviceFlowOptions {
  /** El client id de la GitHub App (`github.clientId` / IA_FLOW_GITHUB_CLIENT_ID). */
  clientId: string
  fetchImpl?: typeof fetch
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

export class DeviceFlow {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: DeviceFlowOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async start(): Promise<DeviceCode> {
    const data = await postForm(this.fetchImpl, DEVICE_CODE_URL, {
      client_id: this.options.clientId,
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
      return {
        status: 'ok',
        access_token: data.access_token,
        login: await this.login(data.access_token),
      }
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

  login(token: string): Promise<string> {
    return githubLogin(token, this.fetchImpl)
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
