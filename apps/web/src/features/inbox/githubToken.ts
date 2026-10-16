import { createLogger } from '@ia-flow/telemetry'
import { useGithubSessionStore } from '@/stores/githubSession'

// El token de GitHub con el que se firma lo que la bandeja le pide al runner (una acción, mover o
// agregar una card): renovado si está por vencer; sin sesión —o si GitHub ya no lo renueva— se
// pide el login y no sale el pedido.

const log = createLogger('inbox:github-token')

/** El token, o `null` tras pedir el login. */
export async function tokenOrLogin(): Promise<string | null> {
  const session = useGithubSessionStore()
  const token = await session.token().catch((err: unknown) => {
    log.warn('no se pudo renovar el token de GitHub', { error: String(err) })
    return null
  })
  if (!token) session.requestLogin()
  return token
}
