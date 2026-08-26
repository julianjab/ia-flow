import { readFileSync } from 'node:fs'
import { type GitHubAuthConfig, GitHubAuthConfigSchema } from '@ia-flow/shared'

/**
 * Config de auth desde el entorno. Vive acá y no en el composition root de
 * cada app porque son DOS apps las que la necesitan (`apps/server` y
 * `apps/ai-provider-gateway`) y tienen que leer exactamente las mismas
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
  const keyPath = env.IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH?.trim()
  // El path gana sólo si la variable inline no está: quien setea las dos casi
  // seguro migró de una a la otra y espera que valga la que puso último — pero
  // como no podemos saberlo, la inline (más explícita) manda.
  const privateKey =
    env.IA_FLOW_GITHUB_APP_PRIVATE_KEY?.trim() ||
    (keyPath ? readFileSync(keyPath, 'utf8') : undefined)

  return GitHubAuthConfigSchema.parse({
    mode: env.IA_FLOW_GITHUB_AUTH_MODE?.trim() || 'auto',
    token: env.GITHUB_TOKEN?.trim() || undefined,
    appId: env.IA_FLOW_GITHUB_APP_ID?.trim() || undefined,
    privateKey,
    installationId: env.IA_FLOW_GITHUB_APP_INSTALLATION_ID?.trim() || undefined,
  })
}
