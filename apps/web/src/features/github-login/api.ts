import {
  type DeviceCode,
  DeviceCodeSchema,
  type DevicePoll,
  DevicePollSchema,
  type GithubUserToken,
  GithubUserTokenSchema,
} from '@ia-flow/shared'
import axios from 'axios'

/** Pide un código de device flow al runner (que habla con GitHub). */
export async function startDeviceFlow(): Promise<DeviceCode> {
  const { data } = await axios.post<unknown>('/api/auth/github/device')
  return DeviceCodeSchema.parse(data)
}

/** Una vuelta de sondeo: ¿ya autorizó el usuario en github.com? */
export async function pollDeviceFlow(deviceCode: string): Promise<DevicePoll> {
  const { data } = await axios.post<unknown>('/api/auth/github/device/poll', {
    device_code: deviceCode,
  })
  return DevicePollSchema.parse(data)
}

/**
 * Un token nuevo a cambio del `refresh_token` (GitHub rota los dos). `null`:
 * GitHub ya no lo acepta —vencido, usado o revocado— y hay que volver a
 * loguearse. Una falla de red se lanza: no es motivo para cerrar la sesión.
 */
export async function refreshGithubToken(refreshToken: string): Promise<GithubUserToken | null> {
  const res = await axios.post<unknown>(
    '/api/auth/github/refresh',
    { refresh_token: refreshToken },
    { validateStatus: (status) => status < 500 && status !== 404 && status !== 501 },
  )
  if (res.status === 401 || res.status === 400) return null
  return GithubUserTokenSchema.parse(res.data)
}
