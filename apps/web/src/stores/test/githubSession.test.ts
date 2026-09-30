import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('useGithubSessionStore', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
    setActivePinia(createPinia())
  })

  it('arranca sin sesión y pedir el login abre el sheet', async () => {
    const { useGithubSessionStore } = await import('../githubSession')
    const s = useGithubSessionStore()
    expect(s.github).toBeNull()
    s.requestLogin()
    expect(s.loginOpen).toBe(true)
    s.cancelLogin()
    expect(s.loginOpen).toBe(false)
  })

  it('el login se guarda junto al server: sobrevive a un reload y se borra al salir', async () => {
    const storage = await import('@/features/servers/storage')
    await storage.saveServers([{ baseUrl: window.location.origin }])

    const { useGithubSessionStore } = await import('../githubSession')
    const s = useGithubSessionStore()
    s.requestLogin()
    await s.setGithub({ token: 'gho_1', login: 'ada' })
    expect(s.loginOpen).toBe(false)
    expect((await storage.loadServers())[0]?.github).toEqual({ token: 'gho_1', login: 'ada' })

    // "Recarga": módulos nuevos, mismo localStorage.
    vi.resetModules()
    setActivePinia(createPinia())
    const selection = await import('@/features/servers/selection')
    selection.restoreSelectedServer()
    const again = (await import('../githubSession')).useGithubSessionStore()
    expect(again.github).toEqual({ token: 'gho_1', login: 'ada' })

    await again.logout()
    expect(again.github).toBeNull()
    const storage2 = await import('@/features/servers/storage')
    expect((await storage2.loadServers())[0]?.github).toBeUndefined()
  })
})
