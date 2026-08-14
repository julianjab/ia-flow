import { LocalIssueManager } from '../adapters/local/issue-manager.js'
import { AgentOrchestrator } from '../application/AgentOrchestrator.js'
import { TaskDispatcher } from '../application/TaskDispatcher.js'
import { WorkspaceManager } from '../application/WorkspaceManager.js'
import { getSourceForProject } from '../application/source-registry.js'
import { AssistWithAiUseCase } from '../application/use-cases/AssistWithAiUseCase.js'
import type { IBroadcast } from '../domain/ports/IBroadcast.js'
import type { IIssueManager } from '../domain/ports/IIssueManager.js'
import { BroadcastingExecutionLogRepository } from '../infrastructure/db/BroadcastingExecutionLogRepository.js'
import { SqliteAgentRepository } from '../infrastructure/db/SqliteAgentRepository.js'
import { SqliteEnvVarRepository } from '../infrastructure/db/SqliteEnvVarRepository.js'
import { SqliteExecutionLogRepository } from '../infrastructure/db/SqliteExecutionLogRepository.js'
import { SqliteGlobalSettingsRepository } from '../infrastructure/db/SqliteGlobalSettingsRepository.js'
import { SqliteMcpCatalogRepository } from '../infrastructure/db/SqliteMcpCatalogRepository.js'
import { SqliteProjectConfigRepo } from '../infrastructure/db/SqliteProjectConfigRepo.js'
import { SqliteProjectRepository } from '../infrastructure/db/SqliteProjectRepository.js'
import { SqlitePromptRepository } from '../infrastructure/db/SqlitePromptRepository.js'
import { SqliteRepoRepository } from '../infrastructure/db/SqliteRepoRepository.js'
import { SqliteStatusRepository } from '../infrastructure/db/SqliteStatusRepository.js'
import { SqliteSystemPromptRepository } from '../infrastructure/db/SqliteSystemPromptRepository.js'
import { getDb } from '../infrastructure/db/database.js'
import { FsTaskRepository } from '../infrastructure/fs/FsTaskRepository.js'
import { ProviderRegistry } from '../infrastructure/providers/ProviderRegistry.js'
import { BunShellRunner } from '../infrastructure/shell/BunShellRunner.js'
import { ToolRegistry } from '../infrastructure/tools/ToolRegistry.js'
import { resolveDaemonMode } from '../issue-managers/daemon-mode.js'
import { PollingIssueManager } from '../issue-managers/polling-issue-manager.js'
import { WebhookIssueManager } from '../issue-managers/webhook-issue-manager.js'
import { createLogger } from '../logger.js'
import { setWorkspaceManager } from '../tools/workspace.js'

const log = createLogger('container')

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

export const repoRepo = new SqliteRepoRepository(db)
export const systemPromptRepo = new SqliteSystemPromptRepository(db)
export const projectRepo = new SqliteProjectRepository(db)
export const statusRepo = new SqliteStatusRepository(db)
export const settingsRepo = new SqliteGlobalSettingsRepository(db)
export const agentRepo = new SqliteAgentRepository(db)
export const configRepo = new SqliteProjectConfigRepo(
  systemPromptRepo,
  projectRepo,
  statusRepo,
  settingsRepo,
  agentRepo,
)
export const envRepo = new SqliteEnvVarRepository(db)
export const promptRepo = new SqlitePromptRepository(db)
export const mcpCatalogRepo = new SqliteMcpCatalogRepository(db)
export const executionLogRepo = new BroadcastingExecutionLogRepository(
  new SqliteExecutionLogRepository(db),
  broadcast,
)

// Tasks — filesystem-backed YAML under <repo>/tasks. Path relative to this
// module so it resolves the same way the legacy store.ts did.
import { join } from 'path'
const TASKS_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'tasks')
export const taskRepo = new FsTaskRepository(TASKS_ROOT)

// ─── Registries ───────────────────────────────────────────────────────────

export const providerRegistry = new ProviderRegistry()
export const toolRegistry = new ToolRegistry()

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

export const workspaceManager = new WorkspaceManager(new BunShellRunner())
setWorkspaceManager(workspaceManager)

// ─── Application ──────────────────────────────────────────────────────────

export const orchestrator = new AgentOrchestrator(
  providerRegistry,
  toolRegistry,
  configRepo,
  repoRepo,
  broadcast,
  mcpCatalogRepo,
  executionLogRepo,
  workspaceManager,
)

export const dispatcher = new TaskDispatcher(orchestrator, broadcast, configRepo)

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

export function buildManagers(): IIssueManager[] {
  const broadcastFn = (msg: object) => broadcast.send(msg)
  const managers: IIssueManager[] = [new LocalIssueManager()]

  for (const project of projectRepo.list()) {
    const source = getSourceForProject(project)
    // Local-kind sources are stubs — the real local flow is LocalIssueManager
    // above, one instance shared across projects. Skip to avoid duplicating.
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
    // Webhook by default (see issue-managers/daemon-mode.ts): the daemon waits
    // for provider push events and only falls back to a slow pull. Projects
    // whose provider can't reach this host (no tunnel, firewalled) opt into
    // 'polling' via project.settings.daemonMode or IA_FLOW_DAEMON_MODE.
    const mode = resolveDaemonMode(project)
    managers.push(
      mode === 'polling'
        ? new PollingIssueManager(project.id, source, broadcastFn, statusRepo)
        : new WebhookIssueManager(project.id, source, broadcastFn, statusRepo),
    )
    log.info(
      { projectId: project.id, kind: source.kind, mode },
      'Registered issue manager for project',
    )
  }

  return managers
}
