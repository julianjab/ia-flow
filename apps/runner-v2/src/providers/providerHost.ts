/**
 * `--host`: este runner le presta sus providers locales a otros runners — los expone por HTTP con
 * un `RemoteProviderHost` (`@ia-flow/provider-remote`), y del otro lado cada uno se declara como
 * `type: remote`. Corren acá, con el worktree de acá (el `cwd` de claude-cli sale del evento que
 * viaja con la corrida); las tools del agente vuelven al runner que la despachó.
 *
 * Un host no despacha nada: monta sólo lo que sus providers usan (`mountHost`) — su identidad de
 * GitHub para clonar, su workspace y sus providers. Ni engine, ni fuentes, ni la base de
 * ejecuciones, ni la marca Working: esos son del runner que despacha, y un host que compartiera
 * la base con un `--serve` de la misma máquina retomaría ejecuciones ajenas.
 */
import type { Provider } from '@ia-flow/agent-engine'
import { admissionRules, RemoteProvider, RemoteProviderHost } from '@ia-flow/provider-remote'
import type { RunnerConfig } from '../config/RunnerConfig.js'
import { resolveGithubAuth, verifyGithubAuth } from '../github/githubAuth.js'
import { mountWorkspace } from '../workspace/mountWorkspace.js'
import { registerProviders, validateProviderDefaults } from './providers.js'

export const DEFAULT_HOST_PORT = 3002

/** Los providers que expone: los que nombra `host.providers`, o todos los locales. Nunca uno
 *  remoto — prestar lo prestado sólo suma un salto. */
export function hostedProviders(registered: Provider[], section: RunnerConfig['host']): Provider[] {
  const local = registered.filter((provider) => !(provider instanceof RemoteProvider))
  if (!section.providers) return local
  return section.providers.map((id) => {
    const found = local.find((provider) => provider.id === id)
    if (!found) {
      const known = local.map((provider) => provider.id).join(', ')
      throw new Error(`host.providers: "${id}" no es un provider local (hay: ${known})`)
    }
    return found
  })
}

export function createProviderHost(
  providers: Provider[],
  section: RunnerConfig['host'],
  token: string | undefined,
): RemoteProviderHost {
  if (!token?.trim()) {
    throw new Error('--host necesita IA_FLOW_PROVIDER_HOST_TOKEN: el host nunca queda abierto')
  }
  return new RemoteProviderHost({
    providers,
    token,
    ...(section.rules?.length ? { admit: admissionRules(section.rules) } : {}),
    ...(section.orphanAfterSeconds ? { orphanAfterMs: section.orphanAfterSeconds * 1000 } : {}),
  })
}

export interface MountedHost {
  host: RemoteProviderHost
  providers: Provider[]
  githubAuthMode: string
}

/** Lo que un host necesita, y nada más (ver arriba). */
export async function mountHost(
  cfg: RunnerConfig,
  opts: { workspaceDir?: string; token: string | undefined; log: (line: string) => void },
): Promise<MountedHost> {
  validateProviderDefaults(cfg.providers)
  const github = await resolveGithubAuth()
  await verifyGithubAuth(github)
  const { session } = mountWorkspace({
    ...(opts.workspaceDir ? { root: opts.workspaceDir } : {}),
    githubToken: () => github.auth.getToken(),
    log: opts.log,
  })
  const registered = registerProviders(cfg.providers, {
    cwd: (ctx) => session.dirFor(ctx),
    log: opts.log,
  })
  const providers = hostedProviders(registered, cfg.host)
  return {
    host: createProviderHost(providers, cfg.host, opts.token),
    providers,
    githubAuthMode: github.mode,
  }
}
