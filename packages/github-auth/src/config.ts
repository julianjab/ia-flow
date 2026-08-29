import { readFileSync } from 'node:fs'
import { GITHUB_AUTH_MODES, type GitHubAuthConfig, GitHubAuthConfigSchema } from '@ia-flow/shared'
import { createLogger } from './logger.js'

const log = createLogger('github-auth:config')

/**
 * Config de auth desde el entorno. Vive acá y no en el composition root de
 * cada app porque son DOS apps las que la necesitan (`apps/server` y
 * `apps/agent-host`) y tienen que leer exactamente las mismas
 * variables — si cada una lo hiciera a mano, el día que se agregue una
 * tercera variable una de las dos se olvida.
 *
 * | Var | Para qué |
 * | --- | --- |
 * | `IA_FLOW_GITHUB_AUTH_MODE` | `auto` (default) · `static` · `gh-cli` · `github-app` |
 * | `GITHUB_TOKEN` | modo `static` — el PAT de siempre |
 * | `IA_FLOW_GITHUB_APP_ID` | modo `github-app` |
 * | `IA_FLOW_GITHUB_APP_PRIVATE_KEY` | PEM crudo o base64 |
 * | `IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH` | alternativa: path al `.pem` |
 * | `IA_FLOW_GITHUB_APP_INSTALLATION_ID` | opcional con una sola instalación |
 */
export function githubAuthConfigFromEnv(env: Record<string, string | undefined>): GitHubAuthConfig {
  const mode = normalizeMode(env.IA_FLOW_GITHUB_AUTH_MODE?.trim())
  const keyPath = env.IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH?.trim()
  // El path gana sólo si la variable inline no está: quien setea las dos casi
  // seguro migró de una a la otra y espera que valga la que puso último — pero
  // como no podemos saberlo, la inline (más explícita) manda.
  const privateKey =
    env.IA_FLOW_GITHUB_APP_PRIVATE_KEY?.trim() || (keyPath ? readKeyFile(keyPath, mode) : undefined)

  return GitHubAuthConfigSchema.parse({
    mode,
    token: env.GITHUB_TOKEN?.trim() || undefined,
    appId: env.IA_FLOW_GITHUB_APP_ID?.trim() || undefined,
    privateKey,
    installationId: env.IA_FLOW_GITHUB_APP_INSTALLATION_ID?.trim() || undefined,
  })
}

/**
 * Un modo desconocido —un típo en el `.env`, un PUT directo a la API— cae a
 * `auto` con un warn en vez de reventar el `parse()`.
 *
 * El throw acá saldría de `readConfig()` en cada `getToken()`, así que un
 * `IA_FLOW_GITHUB_AUTH_MODE=app` se llevaría puestos `gql`/`rest`, los clones
 * y el MCP — cuando la intención evidente era usar la app y lo peor que puede
 * pasar es que ia-flow elija la estrategia por su cuenta.
 */
function normalizeMode(raw: string | undefined): string {
  if (!raw) return 'auto'
  if ((GITHUB_AUTH_MODES as readonly string[]).includes(raw)) return raw
  log.warn(
    { mode: raw, valid: GITHUB_AUTH_MODES },
    'IA_FLOW_GITHUB_AUTH_MODE desconocido — usando auto',
  )
  return 'auto'
}

/**
 * Un `.pem` que no se puede leer —path mal escrito, archivo borrado, sin
 * permisos— es una GitHub App inusable, no un sistema roto.
 *
 * El guard equivalente ya existe en `buildApp`, pero queda una capa más
 * adentro: si esta lectura tirara, el throw saldría de `readConfig()` ANTES de
 * llegar al factory y se llevaría puestas también las estrategias que sí
 * funcionan. En `auto` degradamos a "no hay key" y seguimos; en el modo
 * explícito es error del operador y tiene que gritar.
 */
function readKeyFile(path: string, mode: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (mode === 'github-app')
      throw new Error(`No se pudo leer IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH (${path}): ${message}`)
    log.warn({ path, error: message }, 'no se pudo leer la private key — auto sigue sin la app')
    return undefined
  }
}
