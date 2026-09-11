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
// Sin `AGENT_HOST_REPOS_BASE` no hay dónde clonar: el provisioner igual se
// cablea (un repo que ya tenga `path` local sigue funcionando) pero un repo
// nuevo falla con un error explícito de `ensureLocalClone`, que es mejor que
// correr sobre un path fantasma.
//
// Qué provider concreto corre detrás de `POST /v1/run` es una decisión
// puramente local a esta instancia — el server principal registra el
// agent-host sin saber (ni necesitar saber) cuál de los dos implementa. Se
// resuelve acá vía `AGENT_HOST_PROVIDER` (default: anthropic-api).

import type { IAgentProvider, LocalToolsMcp } from '@ia-flow/ai-providers'
import {
  AnthropicApiProvider,
  ClaudePrintProvider,
  DEFAULT_PROVIDER_CONFIG,
  ItermClaudeProvider,
  TmuxClaudeProvider,
} from '@ia-flow/ai-providers'
import { githubAuthConfigFromEnv, lazyGitHubCredentials } from '@ia-flow/github-auth'
import { installSlackTools } from '@ia-flow/slack'
import {
  executeLoop,
  getTool,
  getToolDefinitions,
  setGitTokenPort,
  setLoggerFactory as setToolsLoggerFactory,
  setWorkspaceManagerPort,
} from '@ia-flow/tools'
import {
  BunShellRunner,
  setLoggerFactory as setWorkspaceLoggerFactory,
  TerminalWorkspaceProvisioner,
  WorkspaceManager,
  WorktreeWorkspaceProvisioner,
} from '@ia-flow/workspace'
import { createLogger } from './logger.js'
import type { WorkspaceSettings } from './state.js'

setWorkspaceLoggerFactory(createLogger)
// Sin esto, cada `createLogger()` de @ia-flow/tools devuelve el stub no-op de
// packages/tools/src/logger.ts y NUNCA se rebindea: el loop de tools entero de
// un run remoto -- bash_run, fs_*, la compactación -- no escribía una línea en
// ningún lado. El daemon lo wirea en su composition root; acá faltaba.
setToolsLoggerFactory(createLogger)
// El loop de tools de un run remoto corre ACÁ, así que las `slack_*` tienen que
// estar en el registry de este proceso o un agente que las declare se queda sin
// ellas. Con `SLACK_BOT_TOKEN` de este host, no del daemon: es este disco el que
// va a hacer la llamada.
installSlackTools({ logger: createLogger })

/** Sin nada guardado, el env — es el arranque en frío de siempre. */
function envWorkspaceSettings(): WorkspaceSettings {
  return {
    reposBase: Bun.env.AGENT_HOST_REPOS_BASE ?? null,
    worktreeBase: Bun.env.AGENT_HOST_WORKTREE_BASE ?? null,
    gitAuthorName: Bun.env.IA_FLOW_GIT_AUTHOR_NAME ?? null,
    gitAuthorEmail: Bun.env.IA_FLOW_GIT_AUTHOR_EMAIL ?? null,
    gitSigningKeyPath: Bun.env.IA_FLOW_GIT_SIGNING_KEY_PATH ?? null,
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

// La misma credencial, también para el git que corre el AGENTE por `bash_run`
// (el `git push` con el que cierra su trabajo). El clone del provisioner deja
// la URL del remote limpia y nada en `.git/config` a propósito, así que sin
// esto el push depende de que la máquina tenga credenciales ambientales — que
// en una laptop existen (osxkeychain, `gh`) y esconden el problema hasta que
// el mismo agente corre en un contenedor. Ver `gitAuthArgs` en @ia-flow/tools.
setGitTokenPort(() => githubCredentials.getToken())

/**
 * El WorkspaceManager de este proceso, también como port de las tools.
 *
 * `workspace_reset` opera contra el singleton que setea
 * `setWorkspaceManagerPort`; sin cablearlo devuelve "unavailable" en cada
 * llamada. El daemon lo hace en su composition root, y acá faltaba: ahora que
 * el loop de tools de un run remoto corre en este proceso, el port tiene que
 * apuntar al manager que preparó ESTE workspace.
 *
 * Se re-setea en cada construcción a propósito: la pantalla puede cambiar la
 * config del workspace sin reiniciar, y el port tiene que seguir al manager
 * vigente.
 */
function createWorkspaceManager(settings: WorkspaceSettings) {
  const manager = new WorkspaceManager(new BunShellRunner(), {
    reposBase: settings.reposBase ?? undefined,
    worktreeBase: settings.worktreeBase ?? undefined,
    githubToken: () => githubCredentials.getToken(),
    gitAuthorName: settings.gitAuthorName ?? undefined,
    gitAuthorEmail: settings.gitAuthorEmail ?? undefined,
    gitSigningKeyPath: settings.gitSigningKeyPath ?? undefined,
    // El daemon que despachó no ve este disco: no borramos ramas remotas
    // desde acá, sólo el que orquesta la limpieza sabe si terminó el trabajo.
    deleteEmptyBranches: false,
  })
  setWorkspaceManagerPort(manager)
  return manager
}

function createWorkspaceProvisioner(settings: WorkspaceSettings) {
  return new WorktreeWorkspaceProvisioner(createWorkspaceManager(settings))
}

/** El mismo WorkspaceManager, pero con el provisioner que usan los terminales. */
function createTerminalWorkspaceProvisioner(settings: WorkspaceSettings) {
  return new TerminalWorkspaceProvisioner(createWorkspaceManager(settings))
}

const toolExecution = { getToolDefinitions, executeLoop }

/**
 * El MCP de tools de disco de ESTE proceso, para el CLI que spawnea un
 * provider de terminal.
 *
 * Es lo que parte la entrega de tools en dos: las de disco se resuelven en
 * `/v1/mcp` —donde está el workspace que este agent-host preparó— y el resto
 * sigue yendo al `/api/mcp` del daemon, que es el único con la fuente de
 * issues, las credenciales y el registry de pending tasks.
 *
 * Por `localhost`: el CLI corre en esta misma máquina. No hace falta el
 * `publicUrl` ni exponer nada nuevo — a diferencia de `anthropic-api`, donde
 * un MCP lo abre Anthropic y sí tendría que ser alcanzable desde internet.
 *
 * `undefined` sin token: el guard rechaza todo sin él, así que declarar el
 * server sólo le daría al CLI un 401 por cada tool. Mejor que las de disco
 * caigan al daemon —donde al menos fallan con un motivo— que una conexión
 * que nunca va a servir.
 *
 * Perezoso porque el puerto y el token se leen del env, que se termina de
 * cargar después de que este módulo se evalúa.
 */
function localTools(): LocalToolsMcp | undefined {
  const token = Bun.env.API_AI_PROVIDER_TOKEN?.trim()
  if (!token) return undefined
  return {
    url: `http://localhost:${Bun.env.PORT ?? '3002'}`,
    token,
    owns: (name) => getTool(name)?.runsOn === 'agent-disk',
  }
}

/**
 * Corte duro de un run de `claude-print`, en ms. Vacío = sin límite, igual
 * que los caps del engine.
 *
 * `Number()` y no `parseInt`: `parseInt('10m') === 10` aceptaría un typo en
 * silencio y cortaría los runs a 10 milisegundos.
 */
function envRunTimeoutMs(): number | undefined {
  const raw = Bun.env.AGENT_HOST_RUN_TIMEOUT_MS?.trim()
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

async function loadProviderConfig() {
  return DEFAULT_PROVIDER_CONFIG
}

/** Los que esta instancia sabe construir. La pantalla los ofrece tal cual. */
export const AGENT_HOST_PROVIDER_IDS = [
  'anthropic-api',
  'claude-print',
  'tmux-claude',
  'iterm-claude',
] as const
export type AgentHostProviderId = (typeof AGENT_HOST_PROVIDER_IDS)[number]

export function isAgentHostProviderId(value: unknown): value is AgentHostProviderId {
  return AGENT_HOST_PROVIDER_IDS.includes(value as AgentHostProviderId)
}

/** El del entorno — el default cuando nadie eligió nada en la pantalla. */
export function envProviderId(): AgentHostProviderId {
  const fromEnv = Bun.env.AGENT_HOST_PROVIDER
  return isAgentHostProviderId(fromEnv) ? fromEnv : 'anthropic-api'
}

/**
 * Construye el provider que esta instancia expone en `POST /v1/run`.
 *
 * Recibe el id en vez de leer el env adentro para que se pueda cambiar sin
 * reiniciar: la pantalla manda uno y el proceso arma el nuevo en el momento.
 * Un id desconocido cae al default en vez de tumbar el agent-host.
 */
export function createProvider(
  id: string = envProviderId(),
  workspaceSettings: WorkspaceSettings = envWorkspaceSettings(),
): IAgentProvider {
  if (id === 'claude-print') {
    return new ClaudePrintProvider({
      log: createLogger('claude-print'),
      // Sus tools de disco se resuelven en ESTE proceso, no en el daemon.
      localTools,
      // Sin tope salvo que el operador ponga uno: el corte lo decide el
      // engine que despachó, no este runtime. `0` = sin límite.
      timeoutMs: envRunTimeoutMs(),
    })
  }

  // Los de terminal spawnean su sesión en ESTA máquina y el agente vuelve al
  // daemon por `input.daemonUrl` (ver terminal/base.ts). Su
  // `TerminalWorkspaceProvisioner` es el mismo que usa el server: obedece el
  // `workflow` del repo y limpia el worktree al terminar.
  if (id === 'tmux-claude' || id === 'iterm-claude') {
    const deps = {
      terminalBase: { loadProviderConfig, localTools },
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
