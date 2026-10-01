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

  describe('renovar el token', () => {
    const HOUR = 3_600_000
    const renewed = {
      access_token: 'ghu_2',
      login: 'ada',
      expires_in: 28_800,
      refresh_token: 'ghr_2',
      refresh_token_expires_in: 15_897_600,
    }

    async function storeWith(
      github: Record<string, unknown>,
      refresh: (token: string) => Promise<unknown>,
    ) {
      const refreshGithubToken = vi.fn(refresh)
      vi.doMock('@/features/github-login/api', () => ({ refreshGithubToken }))
      localStorage.setItem('ia-flow:servers:selected-github', JSON.stringify(github))
      const selection = await import('@/features/servers/selection')
      selection.restoreSelectedServer()
      const { useGithubSessionStore } = await import('../githubSession')
      return { s: useGithubSessionStore(), refreshGithubToken }
    }

    const expiring = () => ({
      token: 'ghu_1',
      login: 'ada',
      expires_at: Date.now() + 60_000,
      refresh_token: 'ghr_1',
    })

    beforeEach(() => vi.doUnmock('@/features/github-login/api'))

    it('un token con vida por delante sale tal cual, sin pedirle nada a GitHub', async () => {
      const github = { ...expiring(), expires_at: Date.now() + HOUR }
      const { s, refreshGithubToken } = await storeWith(github, async () => renewed)
      expect(await s.token()).toBe('ghu_1')
      expect(refreshGithubToken).not.toHaveBeenCalled()
    })

    it('uno por vencer se renueva antes de salir, y lo nuevo queda guardado', async () => {
      const { s, refreshGithubToken } = await storeWith(expiring(), async () => renewed)
      expect(await Promise.all([s.token(), s.token()])).toEqual(['ghu_2', 'ghu_2'])
      expect(refreshGithubToken).toHaveBeenCalledTimes(1)
      expect(refreshGithubToken).toHaveBeenCalledWith('ghr_1')
      expect(s.github).toMatchObject({ token: 'ghu_2', refresh_token: 'ghr_2' })
      expect(s.github?.expires_at).toBeGreaterThan(Date.now() + 7 * HOUR)
      const stored = JSON.parse(localStorage.getItem('ia-flow:servers:selected-github') ?? '{}')
      expect(stored).toMatchObject({ token: 'ghu_2', refresh_token: 'ghr_2' })
    })

    it('si otra pestaña ya lo renovó, usa ése: el refresh token de ésta ya no sirve', async () => {
      const { s, refreshGithubToken } = await storeWith(expiring(), async () => renewed)
      const other = { token: 'ghu_9', login: 'ada', expires_at: Date.now() + 8 * HOUR }
      localStorage.setItem('ia-flow:servers:selected-github', JSON.stringify(other))
      expect(await s.token()).toBe('ghu_9')
      expect(refreshGithubToken).not.toHaveBeenCalled()
    })

    it('si GitHub ya no lo renueva, la sesión se cierra en vez de dejar un error', async () => {
      const { s } = await storeWith(expiring(), async () => null)
      expect(await s.token()).toBeNull()
      expect(s.github).toBeNull()
    })

    it('un token sin refresh token que vence cierra la sesión', async () => {
      const { refresh_token: _, ...legacy } = expiring()
      const { s, refreshGithubToken } = await storeWith(legacy, async () => renewed)
      expect(await s.token()).toBeNull()
      expect(refreshGithubToken).not.toHaveBeenCalled()
      expect(s.github).toBeNull()
    })

    it('withToken: un 401 renueva y reintenta una vez; otro error pasa de largo', async () => {
      const github = { ...expiring(), expires_at: Date.now() + HOUR }
      const { s } = await storeWith(github, async () => renewed)
      const unauthorized = Object.assign(new Error('401'), {
        isAxiosError: true,
        response: { status: 401 },
      })
      const use = vi.fn(async (token: string) => {
        if (token === 'ghu_1') throw unauthorized
        return `ok con ${token}`
      })
      expect(await s.withToken(use)).toBe('ok con ghu_2')
      expect(use.mock.calls.map(([token]) => token)).toEqual(['ghu_1', 'ghu_2'])

      await expect(
        s.withToken(async () => {
          throw new Error('se cayó la red')
        }),
      ).rejects.toThrow(/red/)
    })
  })
})
