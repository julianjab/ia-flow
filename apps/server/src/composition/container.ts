import { join } from 'path'
import {
  AgentOrchestrator,
  TaskDispatcher,
  getPendingTask,
  listPendingTasks,
  removePendingTask,
  setLoggerFactory as setAgentEngineLoggerFactory,
  setPendingTaskRehydrator,
  setSecretResolver,
} from '@ia-flow/agent-engine'
import {
  AnthropicApiProvider,
  ItermClaudeProvider,
  TmuxClaudeProvider,
  createAgentClassifier,
  createProviderClassifier,
} from '@ia-flow/ai-providers'
import {
  FigmaCredentials,
  setLoggerFactory as setFigmaAuthLoggerFactory,
} from '@ia-flow/figma-auth'
import {
  githubAuthConfigFromEnv,
  lazyGitHubCredentials,
  setLoggerFactory as setGithubAuthLoggerFactory,
} from '@ia-flow/github-auth'
import {
  DivergenceReconciler,
  LocalProjectSource,
  type PendingTaskRegistryPort,
  type ProjectSource,
  SourceDispatcher,
  createDefaultSourceFactory,
  resolveCatchUp,
  resolveDaemonMode,
  resolveProjectFilter,
  setGitHubCredentials,
  setLoggerFactory,
} from '@ia-flow/issue-sources'
import { InMemoryEventBus } from '@ia-flow/rules'
import type { ProviderLimit } from '@ia-flow/shared'
import {
  TASK_MESSAGE_EVENT,
  chatGetPermalink,
  compilePolicy,
  executeLoop,
  getToolDefinitions,
  postMessage,
  setAgentMemoryPort,
  setGitTokenPort,
  setLoadProviderConfig,
  setPausePort,
  setRepoResolverPort,
  setSlackReviewPort,
  setSystemPromptPort,
  setLoggerFactory as setToolsLoggerFactory,
  setWaitPort,
  setWorkspaceManagerPort,
} from '@ia-flow/tools'
import {
  BunShellRunner,
  TerminalWorkspaceProvisioner,
  WorkspaceManager,
  WorktreeWorkspaceProvisioner,
  setLoggerFactory as setWorkspaceLoggerFactory,
} from '@ia-flow/workspace'
import { GithubWebhookTranslator } from '../adapters/github/webhook-events.js'
import { createPendingTaskRehydrator } from '../adapters/pending-task-rehydrator.js'
import { RemoteProviderHealthMonitor } from '../adapters/remote-provider/RemoteProviderHealthMonitor.js'
import { SlackDirectory } from '../adapters/slack/SlackDirectory.js'
import { SlackWebhookTranslator } from '../adapters/slack/webhook-events.js'
import { proposeLinkedBranchName } from '../application/branch-namer.js'
import { PollingPauseService } from '../application/polling-pause.js'
import { AssistWithAiUseCase } from '../application/use-cases/AssistWithAiUseCase.js'
import { EnqueueRunMessageUseCase } from '../application/use-cases/EnqueueRunMessageUseCase.js'
import { IngestWebhookUseCase } from '../application/use-cases/IngestWebhookUseCase.js'
import { PublishScannedItemUseCase } from '../application/use-cases/PublishScannedItemUseCase.js'
import { RequestSlackReviewUseCase } from '../application/use-cases/RequestSlackReviewUseCase.js'
import type { IAgentMemoryRepository } from '../domain/ports/IAgentMemoryRepository.js'
import type { IAgentRepository } from '../domain/ports/IAgentRepository.js'
import type { IBroadcast } from '../domain/ports/IBroadcast.js'
import type { IExecutionStatsRepository } from '../domain/ports/IExecutionStatsRepository.js'
import type { IGlobalSettingsRepository } from '../domain/ports/IGlobalSettingsRepository.js'
import type { IIssueManager } from '../domain/ports/IIssueManager.js'
import type { IMcpCatalogRepository } from '../domain/ports/IMcpCatalogRepository.js'
import type { IProjectRepository } from '../domain/ports/IProjectRepository.js'
import type { IPromptRepository } from '../domain/ports/IPromptRepository.js'
import type { IRepoRepository } from '../domain/ports/IRepoRepository.js'
import type { IRuleRepository } from '../domain/ports/IRuleRepository.js'
import type { IRunMessageRepository } from '../domain/ports/IRunMessageRepository.js'
import type { ISeenItemRepository } from '../domain/ports/ISeenItemRepository.js'
import type { IStatusRepository } from '../domain/ports/IStatusRepository.js'
import type { ISystemPromptRepository } from '../domain/ports/ISystemPromptRepository.js'
import type { IWaitRepository } from '../domain/ports/IWaitRepository.js'
import {
  BroadcastingExecutionLogRepository,
  CONFIG_DIR,
  CompositeExecutionLogRepository,
  RemoteExecutionLogRepository,
  SourceTaggingExecutionLogRepository,
  SqliteAgentMemoryRepository,
  SqliteAgentRepository,
  SqliteEnvVarRepository,
  SqliteExecutionLogRepository,
  SqliteGlobalSettingsRepository,
  SqliteMcpCatalogRepository,
  SqliteProcessedEventRepository,
  SqliteProjectConfigRepo,
  SqliteProjectRepository,
  SqlitePromptRepository,
  SqliteProviderRegistrationRepository,
  SqliteRepoRepository,
  SqliteRuleRepository,
  SqliteRunMessageRepository,
  SqliteSeenItemRepository,
  SqliteStatusRepository,
  SqliteSystemPromptRepository,
  SqliteWaitRepository,
  YamlAgentMemoryRepository,
  YamlAgentRepository,
  YamlGlobalSettingsRepository,
  YamlMcpCatalogRepository,
  YamlProjectRepository,
  YamlPromptRepository,
  YamlRepoRepository,
  YamlRuleRepository,
  YamlStatusRepository,
  YamlSystemPromptRepository,
  getDb,
  pickRepo,
} from '../infrastructure/db/index.js'
import { FsTaskRepository } from '../infrastructure/fs/FsTaskRepository.js'
import { IssueSourcesPollingGate } from '../infrastructure/polling/IssueSourcesPollingGate.js'
import { ProviderRegistry } from '../infrastructure/providers/ProviderRegistry.js'
import { createLogger } from '../logger.js'
import { resolveGithubRepo } from '../repos.js'
import { resolveVariable } from '../variables/index.js'
import { getPreloadedConfig } from './preloaded.js'

// Routes every @ia-flow/issue-sources, @ia-flow/agent-engine and
// @ia-flow/tools module-level `createLogger('scope')` call through this
// app's real Pino + WS-broadcast logger (see each package's logger.ts for
// why call order doesn't matter).
setLoggerFactory(createLogger)
setAgentEngineLoggerFactory(createLogger)
setWorkspaceLoggerFactory(createLogger)
setToolsLoggerFactory(createLogger)
setGithubAuthLoggerFactory(createLogger)
setFigmaAuthLoggerFactory(createLogger)

const log = createLogger('container')
const busLog = createLogger('event-bus')

// Lo que el entrypoint dejó resuelto. Vacío = el server completo de siempre.
//
// El container NO sabe de dónde salió: puede venir de un `runner.yaml`, de un
// test o de una fuente que todavía no existe. Sólo sabe qué piezas puede
// recibir hechas — ver `preloaded.ts` para por qué la flecha va en ese sentido.
const preloaded = getPreloadedConfig()

// ─── Credenciales de GitHub ───────────────────────────────────────────────
//
// Única instancia para TODO lo que habla con GitHub en este proceso: la API
// (GraphQL/REST de `issue-sources`), git (`WorkspaceManager`) y el MCP oficial
// de GitHub. Comparten instancia a propósito — es lo que hace que un
// installation token se renueve una vez y no tres, y que los tres caminos
// actúen con la MISMA identidad.
//
// Es perezoso porque `envRepo.loadIntoProcess()` (index.ts) corre después de
// este módulo: leer el env acá arriba no vería lo guardado en SQLite.
export const githubCredentials = lazyGitHubCredentials(() => githubAuthConfigFromEnv(Bun.env))

setGitHubCredentials(githubCredentials)

/** El MCP remoto de Figma (`https://mcp.figma.com/mcp`) se autentica con un
 *  access token de OAuth que vive minutos. Igual que el installation token de
 *  la GitHub App: se resuelve por uso, nunca se captura. La sesión la deja
 *  `bun run auth:figma`; sin ella el token es `undefined`, que
 *  `interpolateMcpServers` expande a '' — el MCP queda configurado y Figma
 *  contesta 401, en vez de filtrar el `${...}` crudo. */
export const figmaCredentials = new FigmaCredentials()

// Los MCP reciben sus credenciales por `${...}` en la config (ver la migración
// 018 para el de GitHub). Sin este hook resolverían contra el env — un PAT o
// nada — aunque el resto del proceso esté hablando como GitHub App, y el token
// de Figma no existe como env var: lo emite un authorization server y se
// renueva solo.
interface CredentialVar {
  resolve(): Promise<string | undefined>
  /** Si sin token hay que mirar el env con ese mismo nombre. NO es universal:
   *  ver GITHUB_TOKEN abajo. */
  envFallback: boolean
}

const CREDENTIAL_VARS: Record<string, CredentialVar> = {
  // Sin fallback A PROPÓSITO: la estrategia de credenciales ya lee GITHUB_TOKEN
  // por su cuenta en los modos que corresponde. Caer al env cuando la GitHub
  // App no resuelve token haría que el daemon pase a comentar como el humano
  // dueño del PAT sin que nadie tocara config — el cambio de identidad
  // silencioso que `github-auth` existe para hacer visible.
  GITHUB_TOKEN: { resolve: () => githubCredentials.getToken(), envFallback: false },
  // Con fallback: `${FIGMA_TOKEN}` es el nombre que aparece en la config del
  // MCP, así que es el que alguien va a setear a mano en un `.env`.
  // Interceptarlo sin fallback lo expandía a vacío y el MCP contestaba 401 sin
  // que nada dijera por qué.
  FIGMA_TOKEN: { resolve: () => figmaCredentials.getToken(), envFallback: true },
}

async function resolveSecret(name: string): Promise<string | undefined> {
  // `hasOwn` y no `CREDENTIAL_VARS[name]`: el nombre viene de un `${...}` de
  // config, y `${toString}` resolvería por el prototipo a una función que
  // devuelve '[object Object]' en vez de caer al env.
  if (!Object.hasOwn(CREDENTIAL_VARS, name)) return Bun.env[name]
  const { resolve, envFallback } = CREDENTIAL_VARS[name]
  const token = await resolve()
  return token ?? (envFallback ? Bun.env[name] : undefined)
}

setSecretResolver(resolveSecret)

/** Expande `${SECRETO}` en un string de config. Lo usa la acción `http` para
 *  que un token no viva en la fila de la regla: se resuelve por uso, nunca se
 *  captura — misma regla que rige a los MCP. */
export async function interpolateSecrets(input: string): Promise<string> {
  const matches = [...input.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)]
  if (!matches.length) return input
  let out = input
  for (const [placeholder, name] of matches) {
    const value = await resolveSecret(name)
    out = out.replaceAll(placeholder, value ?? '')
  }
  return out
}

// Narrow read-only view of the pending-task registry, satisfying
// @ia-flow/issue-sources' PendingTaskRegistryPort without that package
// depending on @ia-flow/agent-engine's PendingTaskRegistry singleton directly.
const pendingTasksPort: PendingTaskRegistryPort = {
  getPendingTask,
  listPendingTasks,
  removePendingTask,
}

// ─── Broadcast (mutable — wired after WebSocket is ready) ─────────────────

class MutableBroadcast implements IBroadcast {
  private fn: (msg: object) => void = () => {}

  setFn(fn: (msg: object) => void): void {
    this.fn = fn
  }

  send(msg: object): void {
    this.fn(msg)
  }
}

export const broadcast = new MutableBroadcast()

// ─── Bus de eventos ───────────────────────────────────────────────────────
// Una sola instancia por proceso. Los productores publican acá y los handlers
// se registran en `daemon.ts` (uno por manager, y se desregistran en el reload
// junto con el manager que los creó).
// Dedupe por identidad del evento. Es lo que hace que el `id` sirva para algo:
// GitHub y Slack reintentan deliveries, y un tick de cron que se solapa con el
// anterior comparte minuto — sin esto, cada uno dispara las reglas dos veces.
//
// Perezoso porque el bus se declara ANTES que `db` en este módulo (el orden lo
// impone el resto del cableado), y capturarlo acá lo leería sin asignar.
let processedEventsRepo: SqliteProcessedEventRepository | null = null
function processedEvents(): SqliteProcessedEventRepository {
  processedEventsRepo ??= new SqliteProcessedEventRepository(db)
  return processedEventsRepo
}

export const eventBus = new InMemoryEventBus({
  markProcessed: async (event) => processedEvents().markProcessed(event),
  onDuplicate: (event) =>
    busLog.debug({ type: event.type, id: event.id }, 'Evento duplicado — descartado'),
  onError: (err, { event, handlerId }) =>
    busLog.error({ err, handlerId, type: event.type, id: event.id }, 'Event handler failed'),
  onDepthExceeded: (event) =>
    busLog.error(
      { type: event.type, id: event.id, depth: event.depth, causationId: event.causationId },
      'Event depth exceeded — posible ciclo de reglas, evento descartado',
    ),
})

// ─── DB ───────────────────────────────────────────────────────────────────

const db = getDb()

// ─── Repositories ─────────────────────────────────────────────────────────

// Each dual-source repo below picks SQLite (default, editable via the CRUD
// UI) or a static YAML file (read-only — for fixed-engine deployments that
// ship their roster as deploy config, e.g. a container running only a
// refiner). See infrastructure/db/yaml/Yaml*Repository.ts and
// infrastructure/db/index.ts (`pickRepo`/`resolveRepoSource`) for the
// selection mechanics — per-repo env var wins, then the global
// IA_FLOW_REPO_SOURCE, then 'sqlite'.
export const repoRepo: IRepoRepository = pickRepo<IRepoRepository>({
  preloaded: preloaded.repos ? new YamlRepoRepository(preloaded.repos) : undefined,
  sqlite: () => new SqliteRepoRepository(db),
  yaml: () => new YamlRepoRepository(Bun.env.IA_FLOW_REPOS_FILE ?? join(CONFIG_DIR, 'repos.yaml')),
  envVar: 'IA_FLOW_REPOS_REPO',
})
export const systemPromptRepo: ISystemPromptRepository = pickRepo<ISystemPromptRepository>({
  sqlite: () => new SqliteSystemPromptRepository(db),
  yaml: () =>
    new YamlSystemPromptRepository(
      Bun.env.IA_FLOW_SYSTEM_PROMPTS_FILE ?? join(CONFIG_DIR, 'system-prompts.yaml'),
    ),
  envVar: 'IA_FLOW_SYSTEM_PROMPT_REPO',
})
export const projectRepo: IProjectRepository = pickRepo<IProjectRepository>({
  preloaded: preloaded.projects ? new YamlProjectRepository(preloaded.projects) : undefined,
  sqlite: () => new SqliteProjectRepository(db),
  yaml: () =>
    new YamlProjectRepository(Bun.env.IA_FLOW_PROJECTS_FILE ?? join(CONFIG_DIR, 'projects.yaml')),
  envVar: 'IA_FLOW_PROJECT_REPO',
})
// Gate de polling: el Set en memoria que consulta el dispatcher, más el
// servicio que lo espeja en projects.settings.pollingPaused.
export const pollingGate = new IssueSourcesPollingGate()
export const pollingPause = new PollingPauseService(projectRepo, pollingGate)

export const statusRepo: IStatusRepository = pickRepo<IStatusRepository>({
  sqlite: () => new SqliteStatusRepository(db),
  yaml: () =>
    new YamlStatusRepository(Bun.env.IA_FLOW_STATUSES_FILE ?? join(CONFIG_DIR, 'statuses.yaml')),
  envVar: 'IA_FLOW_STATUS_REPO',
})
// El deploy headless define sus reglas en el `runner.yaml` y llegan precargadas
// (ver `preloaded.ts`); ahí el repositorio es de sólo lectura. El server
// completo usa SQLite. Mismo patrón que `agentRepo`, pero sin `pickRepo`: no
// hay un YAML suelto que elegir por env var — o vino precargado, o es SQLite.
export const ruleRepo: IRuleRepository = preloaded.rules
  ? new YamlRuleRepository(preloaded.rules)
  : new SqliteRuleRepository(db)

// Sin variante YAML: una espera es estado de runtime, no config. Un deploy
// headless las crea y las consume igual — lo que no tiene es un archivo donde
// declararlas, porque no tendría sentido.
export const waitRepo: IWaitRepository = new SqliteWaitRepository(db)

// Aparte del anterior aunque compartan la migración que las creó: sus
// consumidores son distintos —el loop del agente drena, la ruta encola— y
// ninguno usa la otra mitad.
export const runMessageRepo: IRunMessageRepository = new SqliteRunMessageRepository(db)

// El board tal como lo dejó el scan anterior. Sin variante YAML: es estado de
// runtime, no config — un deploy headless lo construye solo en su primer scan.
export const seenItemRepo: ISeenItemRepository = new SqliteSeenItemRepository(db)

export const settingsRepo: IGlobalSettingsRepository = pickRepo<IGlobalSettingsRepository>({
  sqlite: () => new SqliteGlobalSettingsRepository(db),
  yaml: () =>
    new YamlGlobalSettingsRepository(
      Bun.env.IA_FLOW_SETTINGS_FILE ?? join(CONFIG_DIR, 'settings.yaml'),
    ),
  envVar: 'IA_FLOW_SETTINGS_REPO',
})
// Agent roster source: SQLite (default, editable via the CRUD UI) or a
// static YAML file (read-only — for engine deployments that ship a fixed
// agent set, e.g. a container running only a refiner). See
// infrastructure/db/yaml/YamlAgentRepository.ts.
export const agentRepo: IAgentRepository = pickRepo<IAgentRepository>({
  preloaded: preloaded.agents ? new YamlAgentRepository(preloaded.agents) : undefined,
  sqlite: () => new SqliteAgentRepository(db),
  yaml: () =>
    new YamlAgentRepository(Bun.env.IA_FLOW_AGENTS_FILE ?? join(CONFIG_DIR, 'agents.yaml')),
  envVar: 'IA_FLOW_AGENT_REPO',
})
export const configRepo = new SqliteProjectConfigRepo(
  systemPromptRepo,
  projectRepo,
  statusRepo,
  settingsRepo,
  agentRepo,
)
export const envRepo = new SqliteEnvVarRepository(db)
export const promptRepo: IPromptRepository = pickRepo<IPromptRepository>({
  sqlite: () => new SqlitePromptRepository(db),
  yaml: () =>
    new YamlPromptRepository(Bun.env.IA_FLOW_PROMPTS_FILE ?? join(CONFIG_DIR, 'prompts.yaml')),
  envVar: 'IA_FLOW_PROMPT_REPO',
})
// MCP catalog source: SQLite (default, editable via the CRUD UI) or a
// static YAML file (read-only — same rationale as agentRepo above). See
// infrastructure/db/yaml/YamlMcpCatalogRepository.ts.
export const mcpCatalogRepo: IMcpCatalogRepository = pickRepo<IMcpCatalogRepository>({
  preloaded: preloaded.mcp ? new YamlMcpCatalogRepository(preloaded.mcp) : undefined,
  sqlite: () => new SqliteMcpCatalogRepository(db),
  yaml: () =>
    new YamlMcpCatalogRepository(
      Bun.env.IA_FLOW_MCP_CATALOG_FILE ?? join(CONFIG_DIR, 'mcp-catalog.yaml'),
    ),
  envVar: 'IA_FLOW_MCP_CATALOG_REPO',
})
// Memoria persistente de los agentes: lo único que un agente se lleva de un run
// al siguiente. SQLite por default; la variante YAML es de SOLO LECTURA (ver
// YamlAgentMemoryRepository) para un deploy headless que quiera darle a sus
// agentes un contexto fijo sin una DB escribible al lado.
export const agentMemoryRepo: IAgentMemoryRepository = pickRepo<IAgentMemoryRepository>({
  sqlite: () => new SqliteAgentMemoryRepository(db),
  yaml: () =>
    new YamlAgentMemoryRepository(
      Bun.env.IA_FLOW_AGENT_MEMORY_FILE ?? join(CONFIG_DIR, 'agent-memories.yaml'),
    ),
  envVar: 'IA_FLOW_AGENT_MEMORY_REPO',
})
// Providers remotos (instancias de apps/agent-host registradas vía
// /api/provider-registrations). Sin variante YAML — es inherentemente un
// registro en caliente (POST valida contra el agent-host vivo), no un roster
// que tenga sentido versionar como deploy config.
export const providerRegistrationRepo = new SqliteProviderRegistrationRepository(db)
// When IA_FLOW_REMOTE_EXECUTIONS_URL is set (headless engine containers,
// e.g. agents/subscriptions-pipeline), compose the local Sqlite repo with a
// RemoteExecutionLogRepository forwarding to the main daemon's
// /api/remote-executions — same shared secret as IA_FLOW_REMOTE_LOG_URL
// (see logger.ts). Local write always happens first, so a network blip
// never loses a row — it just stays invisible to the main daemon's UI until
// queried locally. Mirrors the always-local-plus-optional-forward shape of
// the logger's remote sink.
//
// IA_FLOW_INSTANCE_ID (same env var logger.ts reads to tag extras.source)
// wraps the result in SourceTaggingExecutionLogRepository so every row this
// process inserts — local-only or forwarded — carries which container ran
// it, powering the Ejecuciones/Logs "container" filter.
const INSTANCE_ID = Bun.env.IA_FLOW_INSTANCE_ID?.trim() || undefined
const remoteExecutionsUrl = Bun.env.IA_FLOW_REMOTE_EXECUTIONS_URL?.trim()
// Trimmed the same way remoteLogSecret()/remoteExecutionsSecret() trim on
// the receiving end (routes/remote-logs.ts, routes/remote-executions.ts) —
// an untrimmed token here (trailing newline from a `.env` file) would send
// a value that never equals the receiver's trimmed secret, failing every
// forward with a 401 that only ever surfaces as a `warn` log.
const remoteToken = Bun.env.IA_FLOW_REMOTE_LOG_TOKEN?.trim() || undefined
const localExecutionLogRepo = new SqliteExecutionLogRepository(db, INSTANCE_ID ?? null)
// Aggregate reads go straight to the local DB, deliberately skipping the
// decorator stack below: broadcasting/source-tagging/remote-forwarding all
// wrap the WRITE path, and the remote mirror is write-only — it has nothing
// to aggregate. Typed as the narrow read-only port so routes can't reach the
// write methods through it.
export const executionStatsRepo: IExecutionStatsRepository = localExecutionLogRepo
const rawExecutionLogRepo = remoteExecutionsUrl
  ? new CompositeExecutionLogRepository([
      localExecutionLogRepo,
      new RemoteExecutionLogRepository(remoteExecutionsUrl, remoteToken),
    ])
  : localExecutionLogRepo
export const executionLogRepo = new BroadcastingExecutionLogRepository(
  INSTANCE_ID
    ? new SourceTaggingExecutionLogRepository(rawExecutionLogRepo, INSTANCE_ID)
    : rawExecutionLogRepo,
  broadcast,
)

// Tasks — filesystem-backed YAML under <repo>/tasks. Path relative to this
// module so it resolves the same way the legacy store.ts did.
//
// `IA_FLOW_TASKS_ROOT` gana, y no es un lujo: `bun build --compile` resuelve
// `import.meta.dir` a un path virtual DENTRO del ejecutable (`/$bunfs/...`),
// donde no hay ningún `tasks/`. Sin el override, el binario distribuible
// arrancaba con un `local-fs` apuntando a un directorio inexistente.
const TASKS_ROOT =
  Bun.env.IA_FLOW_TASKS_ROOT ?? join(import.meta.dir, '..', '..', '..', '..', 'tasks')
export const taskRepo = new FsTaskRepository(TASKS_ROOT)

// ─── Registries ───────────────────────────────────────────────────────────

export const providerRegistry = new ProviderRegistry()

// Sondea los agent-hosts remotos y mantiene el registry en sincronía con su
// salud: un `remote:<name>` sólo está registrado —y por lo tanto es elegible
// por un agente— mientras conteste. Ver adapters/remote-provider/
// RemoteProviderHealthMonitor.ts. Lo arranca index.ts, después de cablear el
// broadcast, para que el primer cambio de estado ya llegue a la web.
// El intervalo y el timeout los lee el monitor de env por su cuenta y en
// cada vuelta (`IA_FLOW_REMOTE_HEALTH_INTERVAL_MS` / `_TIMEOUT_MS`) — no acá,
// que corre al importar el módulo, antes de `envRepo.loadIntoProcess()`.
export const remoteProviderHealth = new RemoteProviderHealthMonitor(
  providerRegistrationRepo,
  providerRegistry,
  broadcast,
)
export const sourceFactory = createDefaultSourceFactory({ taskRepo })

export function getSourceForProjectId(projectId: string): ProjectSource {
  const project = projectRepo.get(projectId)
  if (!project) throw new Error(`Project '${projectId}' not found`)
  return sourceFactory.get(project)
}

// El registry de tareas en vuelo pasa a ser un cache: cuando no tiene una
// entrada, la reconstruye desde `execution_logs`. Es lo que permite que un
// agente async cierre su run aunque este proceso haya reiniciado mientras él
// trabajaba — antes su `complete_task` rebotaba con "No pending task" y el
// issue quedaba mudo. Ver adapters/pending-task-rehydrator.ts.
setPendingTaskRehydrator(
  createPendingTaskRehydrator({
    executionLogRepo,
    sourceFor: getSourceForProjectId,
    broadcast: (msg: object) => broadcast.send(msg),
    ownSource: INSTANCE_ID ?? null,
  }),
)

// ─── Workspace ────────────────────────────────────────────────────────────
//
// Una sola instancia maneja el ciclo de vida de los worktrees y el mutex por
// task de TODO el daemon. Cableada en:
//   • los provisioners de abajo — que cada provider usa para preparar su
//     terreno (`IAgentProvider.prepareWorkspace`);
//   • AgentOrchestrator — toma y suelta el lock por task, para cualquier
//     provider (el lock es del engine, no del provider);
//   • tools/workspace.ts — `reset_worktree` necesita el mismo singleton para
//     que el agente pueda rehacer su worktree a mitad de run.
// El shell runner es `BunShellRunner` (Bun.spawn). Los tests instancian su
// propio `WorkspaceManager` con un `ShellRunner` stub y saltean este wiring.

/**
 * Quién más está trabajando una task, para que la limpieza automática del
 * worktree terminal no borre el directorio de un run vivo.
 *
 * Dos fuentes, en ese orden:
 *   • `listPendingTasks()` — runs que ESTE proceso está corriendo. Gratis y
 *     siempre al día.
 *   • `executionLogRepo.listActive()` — filas abiertas (`finished_at IS
 *     NULL`), que es lo único que sobrevive a un reinicio del daemon. El
 *     caso que motiva el guard es exactamente ese: el lock por task vive en
 *     memoria, el restart lo pierde, y la sesión de tmux del run original
 *     sigue viva del otro lado (`reconcileOrphanedRuns` deja su fila abierta
 *     justamente porque la sesión responde).
 *
 * Sólo cuentan las filas de ESTE container: las reenviadas por otro daemon
 * describen runs en otra máquina, que no comparten este disco.
 */
function otherLiveRunsOnTask(taskId: string, excludeRunId?: string): string[] {
  const runIds = new Set<string>()
  for (const [id, entry] of listPendingTasks()) {
    if (id !== taskId || entry.cancelled) continue
    if (entry.runId && entry.runId !== excludeRunId) runIds.add(entry.runId)
  }
  for (const row of executionLogRepo.listActive()) {
    if (row.taskId !== taskId) continue
    if ((row.source ?? null) !== (INSTANCE_ID ?? null)) continue
    if (row.runId && row.runId !== excludeRunId) runIds.add(row.runId)
  }
  return [...runIds]
}

export const workspaceManager = new WorkspaceManager(new BunShellRunner(), {
  // Distinct from the (unconfigurable) worktree base — persistent clones
  // live under the app's config dir so `ensureLocalClone` survives restarts.
  reposBase: join(CONFIG_DIR, 'repos'),
  // Resolver, no string: ver `#resolveGithubToken` en WorkspaceManager — un
  // installation token vive una hora y este proceso vive días.
  githubToken: () => githubCredentials.getToken(),
  gitAuthorName: Bun.env.IA_FLOW_GIT_AUTHOR_NAME,
  gitAuthorEmail: Bun.env.IA_FLOW_GIT_AUTHOR_EMAIL,
  // Al limpiar un worktree terminal, si la branch no aporta nada sobre la base
  // se borra también en `origin` (evita ramas huérfanas de runs sin cambios).
  // IA_FLOW_KEEP_EMPTY_BRANCHES=1 desactiva sólo el borrado remoto.
  deleteEmptyBranches: Bun.env.IA_FLOW_KEEP_EMPTY_BRANCHES !== '1',
  // Segundo guard de `cleanupTerminalWorktree`: no borrar el worktree que
  // otro run vivo está usando. Ver `otherLiveRunsOnTask` arriba.
  otherLiveRunsOnTask,
})
setWorkspaceManagerPort(workspaceManager)
// La misma credencial que usa `WorkspaceManager`, ahora también para el git
// que corre el AGENTE por `bash_run`. Sin esto su `git push` no lleva ninguna
// credencial: el provisioner deja la URL del remote limpia y nada en
// `.git/config` a propósito (para que un `fs_read` no lea el token), así que
// el push sólo funcionaba donde la máquina tuviera credenciales ambientales.
// Resolver, no string — un installation token vive una hora.
setGitTokenPort(() => githubCredentials.getToken())

// Los dos provisioners que los providers reciben inyectados. Son las DOS
// formas de aterrizar un `WorkspaceRequest` que existen hoy, y comparten el
// mismo WorkspaceManager (mismo lock, misma convención de nombres, misma
// cadena de fallbacks de git) — que es justamente lo que antes no pasaba:
// `anthropic-api` usaba el manager y los terminal tenían su copia adentro de
// `terminal-base`.
// Sin provisioner, `AnthropicApiProvider.prepareWorkspace` devuelve
// EMPTY_WORKSPACE_PLAN: el run no clona, no crea worktrees y no hace `cd` a
// ningún lado — lo que corresponde a un roster que lee y escribe por el MCP de
// GitHub. Lo elige el deploy (`settings.workspace` del runner.yaml), no el
// flavor: un roster que escribe código lo necesita incluso —sobre todo— en su
// `anthropic-api`, que es lo que corre cuando ningún remoto acepta la tarea.
export const syncWorkspaceProvisioner =
  preloaded.workspace === false ? undefined : new WorktreeWorkspaceProvisioner(workspaceManager)
export const terminalWorkspaceProvisioner = new TerminalWorkspaceProvisioner(workspaceManager)

// ─── Tool-engine ports (@ia-flow/tools) ────────────────────────────────────
// The package's engine + built-in tools are DB-agnostic — they receive the
// concrete (DB-backed) implementations as injected ports here, same
// composition-root pattern as the AI providers below.
setSystemPromptPort({ getById: (id) => systemPromptRepo.getById(id) })
setRepoResolverPort({ resolveGithubRepo })
// El port de memoria es async y el repo es sync (bun:sqlite): el adaptador
// existe para que mover el store a algo remoto no obligue a tocar las tools.
setAgentMemoryPort({
  get: async (agentId, projectId, key) => agentMemoryRepo.get(agentId, projectId, key),
  list: async (agentId, projectId) => agentMemoryRepo.list(agentId, projectId),
  search: async (agentId, projectId, term) => agentMemoryRepo.search(agentId, projectId, term),
  upsert: async (entry) => agentMemoryRepo.upsert(entry),
  deleteByKey: async (agentId, projectId, key) =>
    agentMemoryRepo.deleteByKey(agentId, projectId, key),
})

// El id lo genera el composition root y no la tool: la tool describe la
// intención (qué evento, hasta cuándo) y el store decide cómo se identifica.
setWaitPort({
  create: async (input) => {
    const wait = await waitRepo.create({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId,
      agentId: input.agentId,
      on: input.on,
      when: input.when,
      expiresAt: input.expiresAt,
      createdByRun: input.createdByRun,
      checkpoint: null,
      createdAt: new Date().toISOString(),
    })
    return { id: wait.id }
  },
})

// La pausa arma la espera ANTES de que exista el checkpoint: si el proceso
// muere entre la tool y el corte del loop, queda una espera sin estado —
// reanudable desde el prompt, que es peor que reanudar desde el checkpoint
// pero mucho mejor que una task trabada sin nada que la despierte.
setPausePort({
  pause: async (input) => {
    const wait = await waitRepo.create({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId,
      agentId: input.agentId,
      // El único evento que despierta una pausa: el próximo mensaje de esta
      // tarea. No lo elige el agente — una pausa, por definición, espera a la
      // persona que la pidió.
      on: [TASK_MESSAGE_EVENT],
      expiresAt: input.expiresAt,
      checkpoint: null,
      createdAt: new Date().toISOString(),
    })
    return { id: wait.id }
  },
})

// ─── AI providers (@ia-flow/ai-providers) ─────────────────────────────────
//
// The package's providers are DB/tool-registry-agnostic — they receive the
// concrete implementations as injected ports here, at the composition root.
// `loadProviderConfig` is dynamically imported to avoid a static import
// cycle: `application/provider-config.ts` itself imports `projectRepo` /
// `promptRepo` / `repoRepo` from this module.
async function loadProviderConfigPort() {
  const { loadProviderConfig } = await import('../application/provider-config.js')
  return loadProviderConfig()
}

// Also feeds `fs_read`'s Haiku file-simplifier opt-out (`@ia-flow/tools`'s
// fs/fs.ts reads the same on-disk providers.json).
setLoadProviderConfig(loadProviderConfigPort)

const toolExecution = { getToolDefinitions, executeLoop }

export const anthropicApiProvider = new AnthropicApiProvider({
  toolExecution,
  loadProviderConfig: loadProviderConfigPort,
  workspace: syncWorkspaceProvisioner,
  log: createLogger('anthropic-api'),
  skipContextLog: Bun.env.NODE_ENV === 'test',
})

// Exported (not just a local const) so tests can drive `buildClaudeCommand`
// directly via `createTerminalBase(terminalBaseDeps)` without needing a full
// provider instance.
export const terminalBaseDeps = {
  loadProviderConfig: loadProviderConfigPort,
}

export const tmuxClaudeProvider = new TmuxClaudeProvider({
  terminalBase: terminalBaseDeps,
  workspace: terminalWorkspaceProvisioner,
  log: createLogger('tmux-claude'),
})

export const itermClaudeProvider = new ItermClaudeProvider({
  terminalBase: terminalBaseDeps,
  workspace: terminalWorkspaceProvisioner,
  log: createLogger('iterm-claude'),
})

// Desambigua entre providers candidatos de un agente vía Haiku cuando
// `agent.provider` es un array y el filtrado por `when` deja >1 elegible con
// `whenText` (ver packages/agent-engine/src/provider-selection.ts). Mismo
// modelo/auth que el resto de los callers a la Anthropic API en este repo.
export const classifyProvider = createProviderClassifier({
  log: createLogger('provider-classifier'),
})

// Hermano del anterior, para el OTRO `whenText`: el de una regla. Aquél elige
// entre providers candidatos; éste responde sí/no sobre si el evento cumple el
// criterio en texto libre. Vivía en la selección de agentes hasta que la
// migración 059 movió la activación a `rules`; el clasificador es el mismo, lo
// que cambió es quién lo consulta (ver `classifyRule` en daemon.ts).
export const classifyAgent = createAgentClassifier({
  log: createLogger('agent-classifier'),
})

// ─── Application ──────────────────────────────────────────────────────────

// Qué bloque de settings pertenece a qué provider id. El día que un provider
// nuevo traiga su propio bloque, se agrega acá y su cap funciona sin tocar el
// engine.
const PROVIDER_SETTINGS_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['anthropic-api', 'anthropicApi'],
  ['tmux-claude', 'tmuxClaude'],
  ['iterm-claude', 'itermClaude'],
]

export const orchestrator = new AgentOrchestrator(
  providerRegistry,
  configRepo,
  repoRepo,
  broadcast,
  mcpCatalogRepo,
  executionLogRepo,
  workspaceManager,
  // `compilePolicy` now lives in @ia-flow/tools (Phase 4). `branch-namer.ts`
  // and the variables/ catalog stay in apps/server — they read live
  // daemon/env state, not part of the tool engine itself.
  compilePolicy,
  proposeLinkedBranchName,
  resolveVariable,
  classifyProvider,
  // Caps por provider. No hay una tabla de límites: cada provider declara el
  // suyo dentro de sus propios settings (`anthropicApi.maxConcurrentRuns`,
  // …), y acá se arma el mapa por id que el engine sabe consultar. Se lee del
  // blob en cada dispatch, no se congela: cambiar el número desde la UI
  // aplica al siguiente sin reiniciar el daemon. Directo del promptRepo y no
  // vía `loadProviderConfig` para no crear un ciclo de imports
  // (application/provider-config importa este módulo).
  //
  // Los providers remotos no están acá a propósito: su cap real lo lleva el
  // agent-host (`AGENT_HOST_MAX_CONCURRENT_RUNS`), que es el único que ve su
  // ocupación completa, y `RemoteAgentProvider.canAccept` se lo pregunta.
  async () => {
    const blob = (promptRepo.getProviderConfigBlob() ?? {}) as Record<
      string,
      { maxConcurrentRuns?: number } | undefined
    >
    const limits: Record<string, ProviderLimit> = {}
    for (const [providerId, settingsKey] of PROVIDER_SETTINGS_KEYS) {
      const cap = blob[settingsKey]?.maxConcurrentRuns
      if (cap) limits[providerId] = { maxConcurrentRuns: cap }
    }
    return limits
  },
  // `pendingSnapshot`: default (el registry compartido de capacity.ts).
  undefined,
  // La cola de mensajes de un run en curso, contra el mismo store que las
  // esperas: son las dos caras de "qué sobrevive al final de un run".
  {
    pending: async (taskId) => {
      const pending = await runMessageRepo.pending(taskId)
      return pending.map((m) => ({ id: m.id, body: m.body, author: m.author }))
    },
    markDelivered: (ids, runId) => runMessageRepo.markDelivered(ids, runId),
  },
  // Cuelga el checkpoint de la espera que `pause_for_message` armó una vuelta
  // antes. Si la espera no está (el proceso murió entre la tool y el corte),
  // no se inventa una: sin ella no hay a qué volver, y crear una acá dejaría
  // una pausa que nadie pidió.
  {
    attachCheckpoint: async (taskId, checkpoint) => {
      const wait = await waitRepo.getByTask(taskId)
      if (!wait) {
        log.warn({ taskId }, 'Run pausado sin espera armada — el checkpoint se descarta')
        return
      }
      await waitRepo.consume(wait.id)
      await waitRepo.create({ ...wait, checkpoint })
    },
  },
)

export const dispatcher = new TaskDispatcher(
  orchestrator,
  broadcast,
  configRepo,
  undefined,
  executionLogRepo,
)

// Single process-lifetime instance — not one per project. Compares the live
// status of every in-flight `pending` agent run against its source, driven
// by its own timer, independent of whatever any project's watch() emits
// (see @ia-flow/issue-sources' divergence-reconciler.ts doc). Started once
// in daemon.ts's startDaemon(), never recreated on reloadManagers().
export const divergenceReconciler = new DivergenceReconciler({
  resolveSource: (projectId) => {
    const project = projectRepo.get(projectId)
    if (!project) return undefined
    return sourceFactory.get(project)
  },
  // Una pausa no es deriva: el run se detuvo a propósito y quien la pidió
  // suele haber movido el status al hacerlo.
  isPaused: async (taskId) => {
    const wait = await waitRepo.getByTask(taskId)
    return wait?.checkpoint != null
  },
  pendingTasks: pendingTasksPort,
})

// ─── Use cases ────────────────────────────────────────────────────────────

export const assistWithAiUseCase = new AssistWithAiUseCase(systemPromptRepo, projectRepo)

export const enqueueRunMessageUseCase = new EnqueueRunMessageUseCase(
  runMessageRepo,
  waitRepo,
  eventBus,
)

export const publishScannedItemUseCase = new PublishScannedItemUseCase(seenItemRepo, eventBus, {
  onDiffError: (err, ctx) => log.warn({ err, ...ctx }, 'Fallo el diff de status — se sigue igual'),
})

/**
 * Los traductores de webhook, en orden de consulta.
 *
 * Ganar una fuente nueva (Linear, Sentry) es escribir su traductor en
 * `adapters/<sistema>/` y sumarlo a esta lista — la ruta no se toca.
 *
 * `owner/repo` de GitHub → proyecto y repo de ia-flow. Un repo registrado en
 * dos proyectos devuelve el primero: es una ambigüedad real del modelo (nada
 * impide registrarlo dos veces) y elegir el primero es lo mismo que ya hace
 * `/api/repos/lookup`.
 */
export const ingestWebhookUseCase = new IngestWebhookUseCase(
  [
    new GithubWebhookTranslator((owner, repo) => {
      const first = repoRepo.findByGithubRepo(owner, repo)[0]
      return first ? { projectId: first.projectId, repoName: first.name } : null
    }),
    new SlackWebhookTranslator(),
  ],
  eventBus,
)

export const slackDirectory = new SlackDirectory()

export const requestSlackReviewUseCase = new RequestSlackReviewUseCase(repoRepo, projectRepo, {
  postMessage: (input) => postMessage(input),
  getPermalink: async (input) => (await chatGetPermalink(input)).permalink,
})

// `request_slack_review` (la tool) sólo conoce el id de la tarea. El proyecto
// sale del run en vuelo: es el mismo dato con el que el dispatcher la despachó,
// y no hay forma de inferirlo del id (los ids son opacos y por-fuente).
setSlackReviewPort({
  async requestReview({ taskId }) {
    const pending = listPendingTasks().find(([id]) => id === taskId)?.[1]
    const projectId = pending?.task.projectId
    if (!projectId) return `No se pudo resolver el proyecto de la tarea '${taskId}'.`
    const result = await requestSlackReviewUseCase.execute(
      { projectId, taskId, allowFailedCi: true },
      getSourceForProjectId(projectId),
    )
    const who = result.reviewers.map((r) => r.name ?? r.id).join(', ')
    const where = result.kind === 're-review' ? 'en el hilo existente' : 'en un hilo nuevo'
    return `Review pedido en ${result.channel} ${where} a ${who} (PR #${result.prNumber}).${
      result.threadNotPersisted ? ` Aviso: ${result.threadNotPersisted}` : ''
    }`
  },
})

// ─── Manager construction ─────────────────────────────────────────────────
//
// Multi-tenant: one PollingIssueManager per project row, each backed by the
// ProjectSource resolved from that project's config (github URL today, other
// providers later). The Local file-watcher manager is a special case — it's
// push-mode and not tied to a specific project row, so it stays alone.
//
// Called at daemon startup AND on every project mutation (via daemon reload).

// `boot` says whether the process is starting (crash recovery is boot-only);
// `isNew` says, per project+mode, whether this manager existed in the previous
// generation (a new one still needs its first scan, even on a reload). Both
// feed resolveCatchUp — see catch-up.ts for why they're separate concerns.
// Returns the managers plus the `${projectId}:${mode}` key of each one that was
// actually built. The caller must track *those* keys, not projectRepo.list():
// projects skipped here (local kind, read-only source) would otherwise count as
// "already managed", and the day they gain a usable source they'd never get
// their first scan.
export function buildManagers(
  opts: { boot?: boolean; isNew?: (projectId: string, mode: string) => boolean } = {},
): { managers: IIssueManager[]; keys: Set<string> } {
  const broadcastFn = (msg: object) => broadcast.send(msg)
  // Local file-watcher — one SourceDispatcher wrapping LocalProjectSource's
  // own chokidar-backed watch(), same as any other source now. catchUp is
  // off on purpose: watch()'s chokidar instance already fires `add` for
  // every file that exists at startup (ignoreInitial: false) — a
  // SourceDispatcher-level boot scan on top would double-dispatch every
  // task already on disk.
  const managers: IIssueManager[] = [
    new SourceDispatcher(
      'local',
      new LocalProjectSource(taskRepo),
      broadcastFn,
      pendingTasksPort,
      'webhook', // ignored by this source's watch() — fs watchers have no polling mode
      undefined,
      undefined,
      { crashRecovery: false, initialScan: false },
    ),
  ]
  const keys = new Set<string>()
  const boot = opts.boot ?? true
  const isNew = opts.isNew ?? (() => true)

  for (const project of projectRepo.list()) {
    // Una fuente mal configurada (p. ej. kind 'github' sin url) tira al
    // construirse. Aislar el fallo al proyecto: antes escapaba de acá,
    // reventaba startDaemon() y dejaba al resto de los proyectos sin manager
    // por culpa de una fila rota que se arregla desde la UI.
    let source: ProjectSource
    try {
      source = sourceFactory.get(project)
    } catch (err) {
      log.error(
        { err, projectId: project.id, kind: project.source?.kind },
        'Source misconfigurada — proyecto omitido; revisá su provider en la UI',
      )
      continue
    }
    // Local-kind sources are stubs — the real local flow is the
    // SourceDispatcher above, one instance shared across projects. Skip to
    // avoid duplicating.
    if (source.kind === 'local') continue
    // Sources that can't drive an active work loop (no getTransitionManager)
    // are read-only from the daemon's POV — no point spinning a poll loop.
    if (!source.getTransitionManager) {
      log.info(
        { projectId: project.id, kind: source.kind },
        'Source has no TransitionManager — skipping active poll',
      )
      continue
    }
    // Webhook by default (see @ia-flow/issue-sources dispatch/daemon-mode.ts): the daemon waits
    // for provider push events and only falls back to a slow pull. Projects
    // whose provider can't reach this host (no tunnel, firewalled) opt into
    // 'polling' via project.settings.daemonMode or IA_FLOW_DAEMON_MODE.
    const mode = resolveDaemonMode(project)
    // Crash recovery only on boot; first scan also for a manager that didn't
    // exist in the previous generation. See catch-up.ts.
    const catchUp = resolveCatchUp(boot, isNew(project.id, mode))
    // Cheap pre-fetch gate for SourceIssueManager.runCycle (see its doc) —
    // re-checks agentRepo live each call instead of freezing a snapshot, so
    // a project that starts with zero agents starts scanning the moment one
    // gets wired without needing buildManagers() to re-run.
    //
    // Aproximación: desde la migración 059 lo que decide un dispatch es una
    // REGLA habilitada, no un agente, así que el chequeo exacto sería sobre
    // `ruleRepo`. Se queda en agentes porque este gate es sincrónico (corre
    // antes de cada scan) y `ruleRepo` es async; el costo de la aproximación
    // es un scan de más en un proyecto que tiene agentes pero ninguna regla.
    const hasWiredAgents = () => agentRepo.visibleTo(project.id).length > 0
    // Filtro general de proyecto (statusName/repoName/when), previo al
    // matcher — ver packages/issue-sources/src/dispatch/project-filter.ts.
    // `undefined` cuando el proyecto no define `settings.{statusName,repoName,when}`.
    const filter = resolveProjectFilter(project.settings)
    // Cap de runs simultáneos del proyecto. Como `hasWiredAgents`, se releé
    // del repo en cada llamada en vez de congelar el valor: editarlo desde la
    // UI aplica sin rebuildear managers. Ausente/0 = default global de env.
    const projectRunCap = () => {
      const raw = projectRepo.get(project.id)?.settings?.maxConcurrentDispatches
      return typeof raw === 'number' ? raw : undefined
    }
    managers.push(
      new SourceDispatcher(
        project.id,
        source,
        broadcastFn,
        pendingTasksPort,
        mode,
        hasWiredAgents,
        filter,
        catchUp,
        {},
        projectRunCap,
      ),
    )
    keys.add(`${project.id}:${mode}`)
    log.info(
      { projectId: project.id, kind: source.kind, mode, ...catchUp },
      'Registered issue manager for project',
    )
  }

  return { managers, keys }
}
