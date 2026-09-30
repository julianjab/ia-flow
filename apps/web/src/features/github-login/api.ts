import {
  type DeviceCode,
  DeviceCodeSchema,
  type DevicePoll,
  DevicePollSchema,
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
