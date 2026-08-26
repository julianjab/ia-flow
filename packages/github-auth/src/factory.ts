import type { GitHubAuthConfig, ICredentialProvider } from '@ia-flow/shared'
import { type CommandRunner, GhCliCredentials } from './gh-cli.js'
import { GitHubAppCredentials } from './github-app.js'
import { createLogger } from './logger.js'
import { StaticCredentials } from './static.js'

const log = createLogger('github-auth')

/**
 * Construye la estrategia de credenciales. **Único lugar** donde se decide
 * cuál gana: los consumidores reciben un `ICredentialProvider` y no saben (ni
 * les importa) de dónde salió el token.
 *
 * Es async porque `auto` necesita *probar* que `gh` está autenticado antes de
 * elegirlo — una config que "parece" completa pero no funciona es peor que
 * ninguna, porque el fallo aparece recién en el primer dispatch.
 *
 * Nunca tira por falta de config: sin nada configurado devuelve un provider
 * sin token, que es un estado legítimo (repos públicos) y que el caller ya
 * sabe reportar. Un throw acá dejaría el server sin arrancar por no poder
 * hablar con GitHub, que es una feature, no un requisito de boot.
 */
export async function createGitHubCredentials(
  config: GitHubAuthConfig,
  /** Sólo para tests: sondear `gh` de verdad haría que el resultado dependa
   *  de si la máquina que corre la suite tiene sesión abierta. */
  deps: { ghRunner?: CommandRunner } = {},
): Promise<ICredentialProvider> {
  const provider = await resolve(config, deps)
  log.info({ requested: config.mode, ...provider.describe() }, 'credenciales de GitHub resueltas')
  return provider
}

async function resolve(
  config: GitHubAuthConfig,
  deps: { ghRunner?: CommandRunner },
): Promise<ICredentialProvider> {
  switch (config.mode) {
    case 'static':
      return new StaticCredentials(config.token)

    case 'gh-cli': {
      const gh = new GhCliCredentials({ run: deps.ghRunner })
      await gh.probeIdentity()
      return gh
    }

    case 'github-app':
      return buildApp(config, { strict: true }) ?? new StaticCredentials(undefined)

    case 'auto':
      return autoResolve(config, deps)
  }
}

/**
 * Orden de `auto`: app → gh → PAT. De la identidad más específica y duradera a
 * la más genérica, no de la más fácil a la más difícil — si alguien se tomó el
 * trabajo de configurar una App, es porque quiere que el daemon corra como el
 * bot y no como él.
 */
async function autoResolve(
  config: GitHubAuthConfig,
  deps: { ghRunner?: CommandRunner },
): Promise<ICredentialProvider> {
  const app = buildApp(config, { strict: false })
  if (app) return app

  const gh = new GhCliCredentials({ run: deps.ghRunner })
  if (await gh.isAvailable()) {
    await gh.probeIdentity()
    return gh
  }

  const staticCreds = new StaticCredentials(config.token)
  if (!staticCreds.configured)
    log.warn(
      {},
      'sin credenciales de GitHub (ni app, ni gh CLI, ni GITHUB_TOKEN) — sólo repos públicos',
    )
  return staticCreds
}

/**
 * `strict` distingue los dos usos: en modo explícito `github-app` una config
 * a medias es un error del operador y tiene que gritar; en `auto` es
 * simplemente "esta estrategia no está configurada, seguí con la próxima".
 */
function buildApp(config: GitHubAuthConfig, opts: { strict: boolean }): ICredentialProvider | null {
  const { appId, privateKey, installationId } = config
  if (!appId || !privateKey) {
    if (opts.strict)
      throw new Error(
        'IA_FLOW_GITHUB_AUTH_MODE=github-app requiere IA_FLOW_GITHUB_APP_ID y ' +
          'IA_FLOW_GITHUB_APP_PRIVATE_KEY (o _PRIVATE_KEY_PATH).',
      )
    return null
  }
  try {
    // El constructor valida el PEM. En `auto`, una key ilegible es una
    // estrategia que no se puede usar — mismo desenlace que no tenerla — y
    // frenar el proceso entero por eso dejaría al operador sin las otras dos.
    return new GitHubAppCredentials({ appId, privateKey, installationId })
  } catch (err) {
    if (opts.strict) throw err
    log.warn(
      { appId, error: err instanceof Error ? err.message : String(err) },
      'la config de GitHub App no es usable — auto sigue con la próxima estrategia',
    )
    return null
  }
}

/**
 * Envoltorio perezoso: construye la estrategia en el **primer** `getToken()`,
 * no al importar el módulo.
 *
 * Dos razones, y las dos son de orden de arranque:
 *
 * 1. `createGitHubCredentials` es async (probar `gh` cuesta un proceso) y los
 *    composition roots son módulos con exports sincrónicos. Un top-level await
 *    ahí adentro bloquearía el boot entero por una feature que puede no usarse.
 * 2. En `apps/server` las env vars guardadas en SQLite entran al proceso
 *    recién en `envRepo.loadIntoProcess()` (`index.ts`), *después* de que el
 *    container se evalúa. Leer el env al importar vería una config vacía.
 *
 * `readConfig` es una función por lo mismo: se llama tarde, cuando el env ya
 * está completo.
 */
export function lazyGitHubCredentials(readConfig: () => GitHubAuthConfig): ICredentialProvider {
  let pending: Promise<ICredentialProvider> | null = null
  let resolved: ICredentialProvider | null = null

  const init = (): Promise<ICredentialProvider> => {
    // La promesa se guarda (no sólo el resultado) para que N llamadas
    // concurrentes al arrancar el daemon construyan UNA estrategia.
    pending ??= createGitHubCredentials(readConfig()).then(
      (p) => {
        resolved = p
        return p
      },
      (err) => {
        // Un fallo NO se cachea. Si se guardara la promesa rechazada, un PEM
        // mal pegado envenenaría todos los `getToken()` siguientes y corregirlo
        // desde Settings no arreglaría nada hasta reiniciar el daemon — que es
        // justamente lo que este diseño perezoso existe para evitar.
        pending = null
        throw err
      },
    )
    return pending
  }

  return {
    async getToken(scope) {
      return (resolved ?? (await init())).getToken(scope)
    },
    describe() {
      // Antes del primer uso no hay nada que describir sin bloquear. Decirlo
      // explícitamente es mejor que devolver un modo inventado.
      return resolved?.describe() ?? { mode: 'pending' }
    },
  }
}
