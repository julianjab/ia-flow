// El router mínimo: `/` bandeja, `/webhooks`, `/servers`; sin server elegido, todo va a /servers.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const hasChosenServer = vi.fn<() => boolean>()

vi.mock('@/features/servers/selection', () => ({
  hasChosenServer: () => hasChosenServer(),
}))

// Los componentes de las rutas no importan acá: el guard decide por path.
vi.mock('@/views/AppShell.vue', () => ({ default: { template: '<div><router-view/></div>' } }))
vi.mock('@/views/InboxView.vue', () => ({ default: { template: '<div/>' } }))
vi.mock('@/views/WebhooksView.vue', () => ({ default: { template: '<div/>' } }))
vi.mock('@/views/ServerPickerView.vue', () => ({ default: { template: '<div/>' } }))

async function go(to: string): Promise<{ path: string; name: unknown }> {
  vi.resetModules()
  const { default: router } = await import('../index')
  await router.push(to).catch(() => {})
  await router.isReady()
  return { path: router.currentRoute.value.path, name: router.currentRoute.value.name }
}

describe('rutas y guard de server elegido', () => {
  beforeEach(() => {
    hasChosenServer.mockReset()
  })

  it('con un server elegido la raíz es la bandeja', async () => {
    hasChosenServer.mockReturnValue(true)
    expect(await go('/')).toEqual({ path: '/', name: 'inbox' })
  })

  it('/webhooks se monta', async () => {
    hasChosenServer.mockReturnValue(true)
    expect(await go('/webhooks')).toEqual({ path: '/webhooks', name: 'webhooks' })
  })

  it('sin server elegido, la bandeja y los webhooks mandan a /servers', async () => {
    hasChosenServer.mockReturnValue(false)
    expect((await go('/')).path).toBe('/servers')
    expect((await go('/webhooks')).path).toBe('/servers')
  })

  it('/servers queda afuera del corte — es de donde se sale', async () => {
    hasChosenServer.mockReturnValue(false)
    expect(await go('/servers')).toEqual({ path: '/servers', name: 'servers' })
  })

  it('una ruta de la web vieja (dashboard, projects…) cae en la bandeja', async () => {
    hasChosenServer.mockReturnValue(true)
    expect((await go('/dashboard')).path).toBe('/')
    expect((await go('/projects/abc/overview')).path).toBe('/')
  })
})
