// Wiring del provider que esta instancia expone. Alcance de este primer
// corte (ver el plan): solo los `kind: 'sync'` — anthropic-api y
// claude-print — donde una llamada HTTP devuelve el resultado final.
// tmux-claude/iterm-claude quedan afuera: son `kind: 'async'`, spawnean su
// propia sesión de terminal local y necesitan que el `daemonUrl` (host que
// origina el dispatch) sea alcanzable para los callbacks de
// complete_task/fail_task — viable, pero se valida por separado una vez que
// el flujo sync esté probado end-to-end.
//
// El provider recibe su propio `WorkspaceProvisioner` (ver más abajo): esta
// instancia clona el repo que le pidan y arma su worktree en SU disco, a
// partir de las coordenadas que viajan en `ProviderInput.workspace`. Antes
// este proceso no tenía workspace y los tools de filesystem recibían los
// paths de la máquina que originaba el dispatch — o sea, paths inexistentes
// acá.
//
// Sin `GATEWAY_REPOS_BASE` no hay dónde clonar: el provisioner igual se
// cablea (un repo que ya tenga `path` local sigue funcionando) pero un repo
// nuevo falla con un error explícito de `ensureLocalClone`, que es mejor que
// correr sobre un path fantasma.
//
// Qué provider concreto corre detrás de `POST /v1/run` es una decisión
// puramente local a esta instancia — el server principal registra el
// gateway sin saber (ni necesitar saber) cuál de los dos implementa. Se
// resuelve acá vía `GATEWAY_PROVIDER` (default: anthropic-api).
import {
  AnthropicApiProvider,
  ClaudePrintProvider,
  DEFAULT_PROVIDER_CONFIG,
  ItermClaudeProvider,
  TmuxClaudeProvider,
} from '@ia-flow/ai-providers'
import type { IAgentProvider } from '@ia-flow/ai-providers'
import { githubAuthConfigFromEnv, lazyGitHubCredentials } from '@ia-flow/github-auth'
import { executeLoop, getToolDefinitions } from '@ia-flow/tools'
import {
  BunShellRunner,
  TerminalWorkspaceProvisioner,
  WorkspaceManager,
  WorktreeWorkspaceProvisioner,
  setLoggerFactory as setWorkspaceLoggerFactory,
} from '@ia-flow/workspace'
import { createLogger } from './logger.js'
import type { WorkspaceSettings } from './state.js'

setWorkspaceLoggerFactory(createLogger)

/** Sin nada guardado, el env — es el arranque en frío de siempre. */
function envWorkspaceSettings(): WorkspaceSettings {
  return {
    reposBase: Bun.env.GATEWAY_REPOS_BASE ?? null,
    worktreeBase: Bun.env.GATEWAY_WORKTREE_BASE ?? null,
    gitAuthorName: Bun.env.IA_FLOW_GIT_AUTHOR_NAME ?? null,
    gitAuthorEmail: Bun.env.IA_FLOW_GIT_AUTHOR_EMAIL ?? null,
  }
}

/**
 * Workspace propio de esta instancia. `reposBase` decide dónde viven los
 * clones persistentes (sobreviven restarts); los worktrees van al default
 * efímero de `@ia-flow/workspace` salvo que se configure otro.
 *
 * Los valores llegan por parámetro (del estado guardado, editable desde la
 * consola) en vez de leerse del env acá adentro: es lo que permite cambiarlos
 * sin reiniciar el proceso — `createProvider` se vuelve a llamar y el nuevo
 * manager sale con la config nueva. La credencial de GitHub NO viene por ahí:
 * es un secreto y se resuelve por invocación contra `githubCredentials`, que
 * decide sola si es un PAT del env, el `gh` de esta máquina o una GitHub App.
 */
/**
 * Misma estrategia de credenciales que el server (`container.ts`): este
 * proceso clona y pushea repos por su cuenta, así que necesita su propia
 * credencial — el daemon que despacha NO le manda ningún token, y no debería.
 * Perezoso por la misma razón: la config del env puede completarse después de
 * que este módulo se evalúe.
 */
const githubCredentials = lazyGitHubCredentials(() => githubAuthConfigFromEnv(Bun.env))

function createWorkspaceManager(settings: WorkspaceSettings) {
  return new WorkspaceManager(new BunShellRunner(), {
    reposBase: settings.reposBase ?? undefined,
    worktreeBase: settings.worktreeBase ?? undefined,
    githubToken: () => githubCredentials.getToken(),
    gitAuthorName: settings.gitAuthorName ?? undefined,
    gitAuthorEmail: settings.gitAuthorEmail ?? undefined,
    // El daemon que despachó no ve este disco: no borramos ramas remotas
    // desde acá, sólo el que orquesta la limpieza sabe si terminó el trabajo.
    deleteEmptyBranches: false,
  })
}

function createWorkspaceProvisioner(settings: WorkspaceSettings) {
  return new WorktreeWorkspaceProvisioner(createWorkspaceManager(settings))
}

/** El mismo WorkspaceManager, pero con el provisioner que usan los terminales. */
function createTerminalWorkspaceProvisioner(settings: WorkspaceSettings) {
  return new TerminalWorkspaceProvisioner(createWorkspaceManager(settings))
}

const toolExecution = { getToolDefinitions, executeLoop }

async function loadProviderConfig() {
  return DEFAULT_PROVIDER_CONFIG
}

/** Los que esta instancia sabe construir. La pantalla los ofrece tal cual. */
export const GATEWAY_PROVIDER_IDS = [
  'anthropic-api',
  'claude-print',
  'tmux-claude',
  'iterm-claude',
] as const
export type GatewayProviderId = (typeof GATEWAY_PROVIDER_IDS)[number]

export function isGatewayProviderId(value: unknown): value is GatewayProviderId {
  return GATEWAY_PROVIDER_IDS.includes(value as GatewayProviderId)
}

/** El del entorno — el default cuando nadie eligió nada en la pantalla. */
export function envProviderId(): GatewayProviderId {
  const fromEnv = Bun.env.GATEWAY_PROVIDER
  return isGatewayProviderId(fromEnv) ? fromEnv : 'anthropic-api'
}

/**
 * Construye el provider que esta instancia expone en `POST /v1/run`.
 *
 * Recibe el id en vez de leer el env adentro para que se pueda cambiar sin
 * reiniciar: la pantalla manda uno y el proceso arma el nuevo en el momento.
 * Un id desconocido cae al default en vez de tumbar el gateway.
 */
export function createProvider(
  id: string = envProviderId(),
  workspaceSettings: WorkspaceSettings = envWorkspaceSettings(),
): IAgentProvider {
  if (id === 'claude-print') {
    return new ClaudePrintProvider({ log: createLogger('claude-print') })
  }

  // Los de terminal spawnean su sesión en ESTA máquina y el agente vuelve al
  // daemon por `input.daemonUrl` (ver terminal/base.ts). Su
  // `TerminalWorkspaceProvisioner` es el mismo que usa el server: obedece el
  // `workflow` del repo y limpia el worktree al terminar.
  if (id === 'tmux-claude' || id === 'iterm-claude') {
    const deps = {
      terminalBase: { loadProviderConfig },
      workspace: createTerminalWorkspaceProvisioner(workspaceSettings),
      log: createLogger(id),
    }
    return id === 'tmux-claude' ? new TmuxClaudeProvider(deps) : new ItermClaudeProvider(deps)
  }

  return new AnthropicApiProvider({
    toolExecution,
    loadProviderConfig,
    workspace: createWorkspaceProvisioner(workspaceSettings),
    log: createLogger('anthropic-api'),
    // No hay directorio de proyecto donde persistir el log de contexto de
    // cada run — este proceso no tiene un working tree propio.
    skipContextLog: true,
  })
}
