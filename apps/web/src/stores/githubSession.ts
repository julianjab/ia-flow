import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  currentBaseUrl,
  type GithubSession,
  getSelectedGithub,
  setSelectedGithub,
} from '@/features/servers/selection'
import { saveGithubFor } from '@/features/servers/storage'

// Vive en `stores/`, no en una feature, a propósito: la bandeja (acciones), el
// asistente (propuestas) y el shell (chip de sesión) necesitan saber quién es el
// usuario en GitHub y pedir el login, y feature → feature está prohibido. Es
// sólo ESTADO, como `stores/toast.ts`: el device flow lo corre
// `features/github-login/`, y la persistencia es la de `features/servers/`
// (junto al token del server, no en una clave aparte).

export const useGithubSessionStore = defineStore('github-session', () => {
  /** El login del usuario en el server elegido; `null` = sin sesión. */
  const github = ref<GithubSession | null>(getSelectedGithub())
  /** Alguien pidió iniciar sesión: el sheet de `github-login` se abre. */
  const loginOpen = ref(false)

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

  async function logout(): Promise<void> {
    github.value = null
    setSelectedGithub(null)
    await saveGithubFor(currentBaseUrl(), null)
  }

  return { github, loginOpen, requestLogin, cancelLogin, setGithub, logout }
})
