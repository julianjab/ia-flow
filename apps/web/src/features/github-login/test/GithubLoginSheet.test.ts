import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const startDeviceFlow = vi.fn()
const pollDeviceFlow = vi.fn()

vi.mock('@/features/github-login/api', () => ({
  startDeviceFlow: () => startDeviceFlow(),
  pollDeviceFlow: (code: string) => pollDeviceFlow(code),
}))

// El sondeo real espera segundos: acá se resuelve al instante.
vi.mock('@/features/github-login/deviceFlow', async () => {
  const actual = await vi.importActual<typeof import('../deviceFlow')>('../deviceFlow')
  return {
    ...actual,
    pollUntilDone: (o: Parameters<typeof actual.pollUntilDone>[0]) =>
      actual.pollUntilDone({ ...o, sleep: async () => {} }),
  }
})

import { setSelectedGithub } from '@/features/servers/selection'
import { useGithubSessionStore } from '@/stores/githubSession'
import GithubLoginSheet from '../GithubLoginSheet.vue'

const CODE = {
  device_code: 'dc',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
}

async function open() {
  const wrapper = mount(GithubLoginSheet, { attachTo: document.body })
  const session = useGithubSessionStore()
  session.requestLogin()
  await flushPromises()
  return { wrapper, session }
}

describe('GithubLoginSheet', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    setSelectedGithub(null)
    startDeviceFlow.mockReset()
    pollDeviceFlow.mockReset()
    document.body.innerHTML = ''
  })

  it('muestra el código, el link de verificación y un botón de copiar', async () => {
    startDeviceFlow.mockResolvedValue(CODE)
    pollDeviceFlow.mockImplementation(() => new Promise(() => {})) // nunca autoriza
    const { wrapper } = await open()

    expect(document.body.querySelector('[data-test="user-code"]')?.textContent).toBe('WDJB-MJHT')
    const link = document.body.querySelector('a[href="https://github.com/login/device"]')
    expect(link).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Copiar el código"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('al autorizar guarda el login en la sesión y cierra el sheet', async () => {
    startDeviceFlow.mockResolvedValue(CODE)
    pollDeviceFlow
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'ok', access_token: 'gho_x', login: 'ada' })
    const { wrapper, session } = await open()
    await flushPromises()

    expect(session.github).toEqual({ token: 'gho_x', login: 'ada' })
    expect(session.loginOpen).toBe(false)
    wrapper.unmount()
  })

  it('si GitHub rechaza lo dice y ofrece reintentar', async () => {
    startDeviceFlow.mockResolvedValue(CODE)
    pollDeviceFlow.mockResolvedValue({ status: 'denied' })
    const { wrapper, session } = await open()
    await flushPromises()

    expect(document.body.textContent).toContain('Rechazaste la autorización')
    expect(session.github).toBeNull()

    startDeviceFlow.mockClear()
    const retry = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'Reintentar',
    )
    retry?.click()
    await flushPromises()
    expect(startDeviceFlow).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('un error al pedir el código se muestra tal cual', async () => {
    startDeviceFlow.mockRejectedValue(new Error('el runner no tiene GITHUB_CLIENT_ID'))
    const { wrapper } = await open()
    expect(document.body.textContent).toContain('el runner no tiene GITHUB_CLIENT_ID')
    wrapper.unmount()
  })

  it('cancelar cierra el sheet sin guardar nada', async () => {
    startDeviceFlow.mockResolvedValue(CODE)
    pollDeviceFlow.mockImplementation(() => new Promise(() => {}))
    const { wrapper, session } = await open()
    const cancel = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'Cancelar',
    )
    cancel?.click()
    await flushPromises()
    expect(session.loginOpen).toBe(false)
    expect(session.github).toBeNull()
    wrapper.unmount()
  })
})
