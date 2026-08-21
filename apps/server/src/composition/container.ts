import { join } from 'path'
import {
  AgentOrchestrator,
  TaskDispatcher,
  WorkspaceManager,
  getPendingTask,
  listPendingTasks,
  removePendingTask,
  setLoggerFactory as setAgentEngineLoggerFactory,
  worktreePathFor,
} from '@ia-flow/agent-engine'
import {
  AnthropicApiProvider,
  ItermClaudeProvider,
  TmuxClaudeProvider,
} from '@ia-flow/ai-providers'
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
  setLoggerFactory,
} from '@ia-flow/issue-sources'
import {
  buildToolInstructions,
  compilePolicy,
  executeLoop,
  getToolDefinitions,
  setLoadProviderConfig,
  setRepoResolverPort,
  setSystemPromptPort,
  setLoggerFactory as setToolsLoggerFactory,
  setWorkspaceManagerPort,
} from '@ia-flow/tools'
import { proposeLinkedBranchName } from '../application/branch-namer.js'
import { PollingPauseService } from '../application/polling-pause.js'
import { AssistWithAiUseCase } from '../application/use-cases/AssistWithAiUseCase.js'
import type { IAgentRepository } from '../domain/ports/IAgentRepository.js'
import type { IBroadcast } from '../domain/ports/IBroadcast.js'
import type { IGlobalSettingsRepository } from '../domain/ports/IGlobalSettingsRepository.js'
import type { IIssueManager } from '../domain/ports/IIssueManager.js'
import type { IMcpCatalogRepository } from '../domain/ports/IMcpCatalogRepository.js'
import type { IProjectRepository } from '../domain/ports/IProjectRepository.js'
import type { IPromptRepository } from '../domain/ports/IPromptRepository.js'
import type { IRepoRepository } from '../domain/ports/IRepoRepository.js'
import type { IStatusRepository } from '../domain/ports/IStatusRepository.js'
import type { ISystemPromptRepository } from '../domain/ports/ISystemPromptRepository.js'
import {
  BroadcastingExecutionLogRepository,
  CONFIG_DIR,
  CompositeExecutionLogRepository,
  RemoteExecutionLogRepository,
  SourceTaggingExecutionLogRepository,
  SqliteAgentRepository,
  SqliteEnvVarRepository,
  SqliteExecutionLogRepository,
  SqliteGlobalSettingsRepository,
  SqliteMcpCatalogRepository,
  SqliteProjectConfigRepo,
  SqliteProjectRepository,
  SqlitePromptRepository,
  SqliteRepoRepository,
  SqliteStatusRepository,
  SqliteSystemPromptRepository,
  YamlAgentRepository,
  YamlGlobalSettingsRepository,
  YamlMcpCatalogRepository,
  YamlProjectRepository,
  YamlPromptRepository,
  YamlRepoRepository,
  YamlStatusRepository,
  YamlSystemPromptRepository,
  getDb,
  pickRepo,
} from '../infrastructure/db/index.js'
import { FsTaskRepository } from '../infrastructure/fs/FsTaskRepository.js'
import { IssueSourcesPollingGate } from '../infrastructure/polling/IssueSourcesPollingGate.js'
import { ProviderRegistry } from '../infrastructure/providers/ProviderRegistry.js'
import { BunShellRunner } from '../infrastructure/shell/BunShellRunner.js'
import { createLogger } from '../logger.js'
import { resolveGithubRepo } from '../repos.js'
import { resolveVariable } from '../variables/index.js'

// Routes every @ia-flow/issue-sources, @ia-flow/agent-engine and
// @ia-flow/tools module-level `createLogger('scope')` call through this
// app's real Pino + WS-broadcast logger (see each package's logger.ts for
// why call order doesn't matter).
setLoggerFactory(createLogger)
setAgentEngineLoggerFactory(createLogger)
setToolsLoggerFactory(createLogger)

const log = createLogger('container')

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
  sqlite: () => new SqliteMcpCatalogRepository(db),
  yaml: () =>
    new YamlMcpCatalogRepository(
      Bun.env.IA_FLOW_MCP_CATALOG_FILE ?? join(CONFIG_DIR, 'mcp-catalog.yaml'),
    ),
  envVar: 'IA_FLOW_MCP_CATALOG_REPO',
})
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
const TASKS_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'tasks')
export const taskRepo = new FsTaskRepository(TASKS_ROOT)

// ─── Registries ───────────────────────────────────────────────────────────

export const providerRegistry = new ProviderRegistry()
export const sourceFactory = createDefaultSourceFactory({ taskRepo })

export function getSourceForProjectId(projectId: string): ProjectSource {
  const project = projectRepo.get(projectId)
  if (!project) throw new Error(`Project '${projectId}' not found`)
  return sourceFactory.get(project)
}

// ─── Workspace manager ────────────────────────────────────────────────────
//
// One shared instance drives the git worktree lifecycle + per-task mutex for
// every anthropic-api run. Wired into:
//   • AgentOrchestrator — acquires/releases the task lock, calls resolveScopes
//     before each provider.run to inject `readPaths` / `writePaths` sandbox.
//   • tools/workspace.ts — `reset_worktree` needs the same singleton so the
//     agent can nuke and recreate its own worktree mid-run.
// The shell runner is `BunShellRunner` (Bun.spawn). Tests instantiate their
// own `WorkspaceManager` with a stub `ShellRunner` and bypass this wiring.

export const workspaceManager = new WorkspaceManager(new BunShellRunner(), {
  // Distinct from the (unconfigurable) worktree base — persistent clones
  // live under the app's config dir so `ensureLocalClone` survives restarts.
  reposBase: join(CONFIG_DIR, 'repos'),
  githubToken: Bun.env.GITHUB_TOKEN,
  gitAuthorName: Bun.env.IA_FLOW_GIT_AUTHOR_NAME,
  gitAuthorEmail: Bun.env.IA_FLOW_GIT_AUTHOR_EMAIL,
})
setWorkspaceManagerPort(workspaceManager)

// ─── Tool-engine ports (@ia-flow/tools) ────────────────────────────────────
// The package's engine + built-in tools are DB-agnostic — they receive the
// concrete (DB-backed) implementations as injected ports here, same
// composition-root pattern as the AI providers below.
setSystemPromptPort({ getById: (id) => systemPromptRepo.getById(id) })
setRepoResolverPort({ resolveGithubRepo })

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

const toolExecution = { getToolDefinitions, executeLoop, buildToolInstructions }
const worktree = { worktreePathFor }

export const anthropicApiProvider = new AnthropicApiProvider({
  toolExecution,
  loadProviderConfig: loadProviderConfigPort,
  log: createLogger('anthropic-api'),
  skipContextLog: Bun.env.NODE_ENV === 'test',
})

// Exported (not just a local const) so tests can drive `buildClaudeCommand`
// directly via `createTerminalBase(terminalBaseDeps)` without needing a full
// provider instance.
export const terminalBaseDeps = {
  toolExecution,
  loadProviderConfig: loadProviderConfigPort,
  worktree,
}

export const tmuxClaudeProvider = new TmuxClaudeProvider({
  terminalBase: terminalBaseDeps,
  log: createLogger('tmux-claude'),
})

export const itermClaudeProvider = new ItermClaudeProvider({
  terminalBase: terminalBaseDeps,
  log: createLogger('iterm-claude'),
})

// ─── Application ──────────────────────────────────────────────────────────

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
)

export const dispatcher = new TaskDispatcher(orchestrator, broadcast, configRepo)

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
  pendingTasks: pendingTasksPort,
})

// ─── Use cases ────────────────────────────────────────────────────────────

export const assistWithAiUseCase = new AssistWithAiUseCase(systemPromptRepo, projectRepo)

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
    const source = sourceFactory.get(project)
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
    // gets wired without needing buildManagers() to re-run. `.some(enabled)`,
    // not just `.length > 0` — visibleTo() doesn't filter disabled agents,
    // and a project whose only agents are disabled has as little to scan
    // for as one with none at all.
    const hasWiredAgents = () => agentRepo.visibleTo(project.id).some((a) => a.enabled !== false)
    // Filtro general de proyecto (statusName/repoName/when), previo a
    // selectAgent — ver packages/issue-sources/src/dispatch/project-filter.ts.
    // `undefined` cuando el proyecto no define `settings.{statusName,repoName,when}`.
    const filter = resolveProjectFilter(project.settings)
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
