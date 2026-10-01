import type { GithubUserToken } from '@ia-flow/shared'
import { isAxiosError } from 'axios'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { refreshGithubToken } from '@/features/github-login/api'
import {
  currentBaseUrl,
  type GithubSession,
  getSelectedGithub,
  githubSessionOf,
  readStoredGithub,
  setSelectedGithub,
} from '@/features/servers/selection'
import { saveGithubFor } from '@/features/servers/storage'

// Vive en `stores/`, no en una feature, a propósito: la bandeja (acciones), el
// asistente (propuestas) y el shell (chip de sesión) necesitan saber quién es el
// usuario en GitHub y pedir el login, y feature → feature está prohibido. Es
// ESTADO, como `stores/toast.ts`: el device flow lo corre `features/github-login/`,
// y la persistencia es la de `features/servers/` (junto al token del server, no en
// una clave aparte).
//
// El token de una GitHub App vence a las 8 h. Quien lo usa lo pide con `token()`
// —o `withToken()`, que además reintenta ante un 401—, y el store lo renueva con
// el `refresh_token` antes de que venza. Si GitHub ya no lo renueva, la sesión se
// cierra: lo que sigue es «Iniciá sesión», no un error.

/** Cuánto antes de vencer se renueva: un request que sale con 1 s de vida llega vencido. */
export const REFRESH_MARGIN_MS = 5 * 60_000

const fresh = (session: GithubSession, now: number) =>
  session.expires_at === undefined || session.expires_at - now > REFRESH_MARGIN_MS

/** ¿Lo que falló fue el token de GitHub? El runner contesta 401 cuando GitHub no lo reconoce. */
function rejected(err: unknown): boolean {
  return isAxiosError(err) && err.response?.status === 401
}

/**
 * Una sola renovación a la vez entre pestañas: GitHub rota el `refresh_token`,
 * así que dos pestañas que renuevan con el mismo dejan a una afuera. Sin Web
 * Locks (navegador viejo) corre igual, sólo con el candado de esta pestaña.
 */
function exclusive<T>(name: string, task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  return locks ? (locks.request(name, task) as Promise<T>) : task()
}

export const useGithubSessionStore = defineStore('github-session', () => {
  /** El login del usuario en el server elegido; `null` = sin sesión. */
  const github = ref<GithubSession | null>(getSelectedGithub())
  /** Alguien pidió iniciar sesión: el sheet de `github-login` se abre. */
  const loginOpen = ref(false)
  let renewing: Promise<GithubSession | null> | null = null

  function requestLogin(): void {
    loginOpen.value = true
  }

  function cancelLogin(): void {
    loginOpen.value = false
  }

  async function setGithub(next: GithubSession): Promise<void> {
    github.value = next
    loginOpen.value = false
    setSelectedGithub(next)
    await saveGithubFor(currentBaseUrl(), next)
  }

  /** El token que acaba de emitir GitHub (device flow): sus vencimientos pasan a fechas. */
  function signIn(token: GithubUserToken): Promise<void> {
    return setGithub(githubSessionOf(token))
  }

  async function logout(): Promise<void> {
    github.value = null
    setSelectedGithub(null)
    await saveGithubFor(currentBaseUrl(), null)
  }

  /**
   * Una sesión con un token que sirve, en vez de `stale`: la que ya renovó otra
   * pestaña, o una nueva de GitHub. `null` = no se puede renovar y la sesión se
   * cerró. Una falla de red se lanza y la sesión queda como estaba.
   */
  function renew(stale: GithubSession): Promise<GithubSession | null> {
    renewing ??= exclusive(`ia-flow:github-refresh:${currentBaseUrl()}`, async () => {
      // Otra pestaña ya la renovó: la suya sirve o, si también vence, tiene el refresh token vigente.
      const stored = readStoredGithub()
      const newer = stored && stored.login === stale.login && stored.token !== stale.token
      if (newer && fresh(stored, Date.now())) {
        github.value = stored
        return stored
      }
      const latest = newer ? stored : stale
      const usable =
        latest.refresh_token &&
        (latest.refresh_expires_at === undefined || latest.refresh_expires_at > Date.now())
      const token = usable ? await refreshGithubToken(latest.refresh_token as string) : null
      if (!token) {
        await logout()
        return null
      }
      const next = githubSessionOf(token)
      await setGithub(next)
      return next
    }).finally(() => {
      renewing = null
    })
    return renewing
  }

  /** El token de GitHub para un request, renovado si está por vencer; `null` = sin sesión. */
  async function token(): Promise<string | null> {
    const current = github.value
    if (!current) return null
    if (fresh(current, Date.now())) return current.token
    return (await renew(current))?.token ?? null
  }

  /**
   * Corre `use` con el token, y si el runner lo rechaza (401: vencido antes de
   * tiempo, revocado) lo renueva y reintenta UNA vez. `null` = sin sesión.
   */
  async function withToken<T>(use: (token: string) => Promise<T>): Promise<T | null> {
    const first = await token()
    if (!first) return null
    try {
      return await use(first)
    } catch (err) {
      const current = github.value
      if (!rejected(err) || !current) throw err
      const renewed = await renew({ ...current, expires_at: 0 })
      if (!renewed) return null
      return use(renewed.token)
    }
  }

  return {
    github,
    loginOpen,
    requestLogin,
    cancelLogin,
    setGithub,
    signIn,
    logout,
    token,
    withToken,
  }
})
