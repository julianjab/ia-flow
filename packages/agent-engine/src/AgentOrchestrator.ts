import { join } from 'path'
import type { ITaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { Agent, type AgentChainState, type CompilePolicy } from './Agent.js'
import type { WorkspaceManager } from './WorkspaceManager.js'
import { resolveChainContext } from './chain-context.js'
import type {
  IBroadcast,
  IExecutionLogRepository,
  IMcpCatalogRepository,
  IProjectConfigRepository,
  IProviderRegistry,
  IRepoRepository,
} from './contract.js'
import { type LinkedBranchNamer, defaultLinkedBranchNamer } from './linked-branch.js'
import { createLogger } from './logger.js'
import { type ResolveVariable } from './variable-resolver.js'

const log = createLogger('agent-orchestrator')

const HOME = Bun.env.HOME ?? ''
function expandHome(p: string): string {
  return p.startsWith('~/') ? join(HOME, p.slice(2)) : p
}

/**
 * Resolves which agents apply to a task's current status and runs each in
 * sequence via `Agent` — this class owns chain resolution, the per-chain
 * workspace lock, status-drift detection between agents, and terminal
 * worktree cleanup. It does NOT run an agent itself: that lifecycle
 * (onStart → call ai-provider → finalize) lives entirely in `Agent`.
 */
export class AgentOrchestrator {
  private agent: Agent

  // Only `configRepo`, `repoRepo` and `workspaceManager` are used by the
  // orchestrator itself; the rest are forwarded verbatim to `Agent`, which
  // owns the per-agent lifecycle.
  constructor(
    providers: IProviderRegistry,
    private configRepo: IProjectConfigRepository,
    private repoRepo: IRepoRepository,
    broadcast: IBroadcast,
    mcpCatalogRepo?: IMcpCatalogRepository,
    executionLogRepo?: IExecutionLogRepository,
    // WorkspaceManager is optional so existing tests (which build the
    // orchestrator with a minimal fixture) keep working; when absent the
    // orchestrator falls back to the pre-#35 behaviour — no worktree, no
    // writePaths, no per-task lock. The container wires the real one.
    private workspaceManager?: WorkspaceManager,
    // Host-owned ports (composable-engine refactor, Phase 3): policy.ts and
    // branch-namer.ts stay in apps/server (coupled to the tool registry /
    // permission presets and the DB-backed system-prompt lookup
    // respectively), so this package can't import them directly. Both are
    // optional with behavior-preserving defaults — omitting them just means
    // no policy gets compiled / the deterministic `task/<id>` branch name is
    // used, exactly like before an agent opted into either feature.
    compilePolicyPort?: CompilePolicy,
    linkedBranchNamer: LinkedBranchNamer = defaultLinkedBranchNamer,
    // Variable substitution ({{task.title}}, {{project.repos}}, …) is
    // resolved by apps/server's variables/ subsystem (system/task/project/
    // custom groups) — injected here for the same reason. Defaulting to
    // "no known variables" leaves `{{...}}` placeholders untouched, matching
    // `resolveVariables`' own behaviour for any variable it can't resolve.
    resolveVariable: ResolveVariable = () => undefined,
  ) {
    this.agent = new Agent(
      providers,
      broadcast,
      mcpCatalogRepo,
      executionLogRepo,
      workspaceManager,
      compilePolicyPort,
      linkedBranchNamer,
      resolveVariable,
    )
  }

  async runAgent(task: Task, manager: ITaskSource): Promise<boolean> {
    // Scope the config lookup to the task's project when known — matches how
    // TaskDispatcher fetched it. Legacy callers without projectId fall back to
    // the default project (SqliteProjectConfigRepo.getConfig undefined path).
    const config = await this.configRepo.getConfig(task.projectId)
    if (!config) return false

    const chainCtx = resolveChainContext({ task, config, repoRepo: this.repoRepo, expandHome })
    if (!chainCtx) return false
    const {
      statusConfig,
      matchingEntries,
      projectRepos,
      repoPaths,
      primaryRepoName,
      primaryPath,
      primaryWorkflow,
    } = chainCtx

    // ── Workspace lock scope ──────────────────────────────────────────
    // The chain uses the WorkspaceManager only when a) the manager is
    // wired (production always; tests opt-in) and b) at least one agent
    // in the chain runs on `anthropic-api` (the only provider that gets
    // the worktree sandbox — terminal providers stay on the base repo).
    // The lock covers the *entire* chain so a second dispatch on the same
    // task fails fast at `acquireTask` instead of racing with the running
    // one. Releasing lives in the outer `finally` at the bottom so every
    // exit path (success, per-agent throw, upstream abort) cleans up.
    const chainNeedsWorkspace = !!(
      this.workspaceManager &&
      primaryPath &&
      matchingEntries.some((entry) => {
        const def = config.agents?.find((a) => a.id === entry.agent)
        return def?.provider === 'anthropic-api'
      })
    )
    let workspaceLockHeld = false
    if (chainNeedsWorkspace) {
      // May throw `task <id> ya está corriendo` — that's the intended
      // signal to the caller (e.g. a raced dispatcher), so propagate.
      this.workspaceManager!.acquireTask(task.id, primaryPath!)
      workspaceLockHeld = true
    }

    // Mutated by Agent.run so the finally block below can attempt cleanup
    // for a terminal (async) worktree run, regardless of which exit path a
    // later agent in the chain takes.
    const chainState: AgentChainState = {}

    try {
      // Run each matching agent in sequence
      for (const entry of matchingEntries) {
        // Between iterations: if a previous agent (or a tool it called) moved
        // the task out of the status that produced this chain, the remaining
        // agents were selected for a status that no longer applies — stop
        // here and let the next poll cycle re-evaluate against the new status.
        // Fresh-read from the source so we don't act on a stale in-memory
        // status that a prior tool wrote back through a mis-normalized field.
        const freshMidStatus = (await manager.getCurrentStatus?.(task)) ?? task.status
        if (freshMidStatus !== task.status) {
          task = { ...task, status: freshMidStatus }
        }
        if (task.status.toLowerCase() !== statusConfig.name.toLowerCase()) {
          log.info(
            {
              taskId: task.id,
              chainStatus: statusConfig.name,
              currentStatus: task.status,
              skippedAgent: entry.agent,
            },
            'Task status drifted mid-chain — skipping remaining agents',
          )
          break
        }

        const agentDef = config.agents?.find((a) => a.id === entry.agent)
        if (!agentDef) {
          log.error({ agent: entry.agent }, 'Agent not found in agents registry')
          continue
        }

        task = await this.agent.run(
          {
            task,
            entry,
            agentDef,
            manager,
            config,
            projectRepos,
            repoPaths,
            primaryPath,
            primaryRepoName,
            primaryWorkflow,
          },
          chainState,
        )
      }

      return true
    } finally {
      // Release the per-task lock exactly once, no matter which exit path
      // (success return, per-agent throw, chain-level early break) got us
      // here. `releaseTask` is idempotent so a duplicate call from a mis-
      // wired test wouldn't harm anything.
      if (workspaceLockHeld) {
        this.workspaceManager!.releaseTask(task.id)
      }

      // Auto-cleanup: remove the terminal worktree when the run is done and
      // there is no work at risk. Applies only to terminal providers (tmux /
      // iterm) that ran with workflow=worktree — anthropic-api worktrees are
      // managed by WorkspaceManager itself.
      if (chainState.terminalWorktreeBranch && primaryPath && this.workspaceManager) {
        // Use the manager's method (not the free helper) para respetar el
        // `worktreeBase` configurado en el constructor — el helper libre asume
        // el default y divergería silenciosamente si algún día se personaliza.
        const wtPath = this.workspaceManager.worktreePath(task.id, primaryPath)
        const safe = await this.workspaceManager
          .isWorktreeSafeToRemove(wtPath, chainState.terminalWorktreeBranch)
          .catch(() => false)
        if (safe) {
          log.info(
            { taskId: task.id, worktreePath: wtPath, branch: chainState.terminalWorktreeBranch },
            'Auto-removing clean terminal worktree',
          )
          await this.workspaceManager
            .removeWorktree(task.id, primaryPath, chainState.terminalWorktreeBranch)
            .catch((err: unknown) => {
              log.warn(
                {
                  taskId: task.id,
                  worktreePath: wtPath,
                  err: err instanceof Error ? err.message : String(err),
                },
                'Auto-remove worktree failed — worktree stays on disk',
              )
            })
        } else {
          log.warn(
            { taskId: task.id, worktreePath: wtPath, branch: chainState.terminalWorktreeBranch },
            'Terminal worktree has uncommitted or unpushed work — skipping auto-remove (worktree left for manual rescue)',
          )
        }
      }
    }
  }
}
