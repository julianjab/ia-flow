// El guard que evita montar pantallas de server contra un agent-host.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSelectedKind = vi.fn<() => 'server' | 'agent-host' | 'unknown'>()

vi.mock('@/features/servers/selection', () => ({
  getSelectedKind: () => getSelectedKind(),
  getSelectedServer: () => 'http://localhost:3012',
}))

// Los componentes de las rutas no importan acá: el guard decide por path.
vi.mock('@/views/AppShell.vue', () => ({ default: { template: '<div/>' } }))
vi.mock('@/views/DashboardView.vue', () => ({ default: { template: '<div/>' } }))
vi.mock('@/views/GeneralView.vue', () => ({ default: { template: '<div/>' } }))
vi.mock('@/views/ProjectDetailView.vue', () => ({ default: { template: '<div/>' } }))
vi.mock('@/views/ProjectsListView.vue', () => ({ default: { template: '<div/>' } }))
vi.mock('@/views/ServerPickerView.vue', () => ({ default: { template: '<div/>' } }))
vi.mock('@/features/agent-host/AgentHostConsole.vue', () => ({
  default: { template: '<div/>' },
}))
vi.mock('@/features/agent-host/AgentHostLogsView.vue', () => ({
  default: { template: '<div/>' },
}))

async function go(to: string): Promise<string> {
  vi.resetModules()
  const { default: router } = await import('../index')
  await router.push(to).catch(() => {})
  await router.isReady()
  return router.currentRoute.value.path
}

describe('guard por tipo de proceso', () => {
  beforeEach(() => {
    getSelectedKind.mockReset()
  })

  it('con un agent-host elegido, un bookmark a /dashboard no monta el dashboard', async () => {
    // El menú ya no lo ofrece, pero un bookmark o un history.back() sí llegan
    // acá — y DashboardView dispara /api/* contra un proceso que no las tiene.
    getSelectedKind.mockReturnValue('agent-host')

    expect(await go('/dashboard')).toBe('/agent-host')
  })

  it('tampoco monta el detalle de un proyecto', async () => {
    getSelectedKind.mockReturnValue('agent-host')

    expect(await go('/projects/abc/overview')).toBe('/agent-host')
  })

  it('/servers queda afuera del corte — es de donde se sale', async () => {
    getSelectedKind.mockReturnValue('agent-host')

    expect(await go('/servers')).toBe('/servers')
  })

  it('los logs del agent-host sí se montan', async () => {
    getSelectedKind.mockReturnValue('agent-host')

    expect(await go('/agent-host/logs')).toBe('/agent-host/logs')
  })

  it('con un server elegido no cambia nada', async () => {
    getSelectedKind.mockReturnValue('server')

    expect(await go('/dashboard')).toBe('/dashboard')
  })
})
