import { join } from 'path'
import type { ITaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { Agent, type AgentRunState, type CompilePolicy } from './Agent.js'
import { type WorkspaceManager, needsWorkspace } from './WorkspaceManager.js'
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
import { resolveRunContext } from './run-context.js'
import { type ResolveVariable } from './variable-resolver.js'

const log = createLogger('agent-orchestrator')

const HOME = Bun.env.HOME ?? ''
function expandHome(p: string): string {
  return p.startsWith('~/') ? join(HOME, p.slice(2)) : p
}

/**
 * Resuelve **qué agente** aplica a un issue y lo corre vía `Agent`. Esta clase
 * es dueña de la resolución del contexto de run, el lock de workspace por task
 * y la limpieza del worktree terminal. NO corre el agente ella misma: ese
 * ciclo (onStart → llamar al ai-provider → finalizar) vive entero en `Agent`.
 *
 * Un dispatch corre **un** agente, no una cadena: `selectAgent` devuelve el
 * primero que cumple project + repo + status + when, y los outcomes de ese run
 * mueven el issue al siguiente status. El ciclo de poll siguiente vuelve a
 * seleccionar contra el status nuevo — así avanza el pipeline, sin que ningún
 * componente tenga que conocer la cadena completa de antemano.
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

    // Fresh-read el status antes de seleccionar: el item pudo quedar encolado
    // detrás de otro dispatch que ya lo movió, y elegir contra un status en
    // memoria viejo correría el agente equivocado. Es el mismo chequeo que
    // antes vivía entre agentes de la cadena, ahora adelantado a la selección.
    const freshStatus = (await manager.getCurrentStatus?.(task)) ?? task.status
    if (freshStatus !== task.status) {
      log.debug(
        { taskId: task.id, staleStatus: task.status, currentStatus: freshStatus },
        'Status cambió antes del dispatch — seleccionando contra el status fresco',
      )
      task = { ...task, status: freshStatus }
    }

    const runCtx = resolveRunContext({
      task,
      agents: config.agents ?? [],
      repoRepo: this.repoRepo,
      expandHome,
    })
    if (!runCtx) return false
    let { primaryPath } = runCtx
    const { agent, primaryRepoName, primaryTaskRepo } = runCtx

    // Repo registrado sin path local todavía (nada lo clonó nunca) — si trae
    // coordenadas de GitHub, WorkspaceManager lo clona antes de seguir y
    // persistimos el path resultante para que el próximo dispatch ya lo
    // encuentre. Sin esto el run seguiría con `primaryPath` undefined y el
    // agente no tendría dónde leer/escribir.
    if (
      !primaryPath &&
      this.workspaceManager &&
      primaryTaskRepo?.githubOwner &&
      primaryTaskRepo?.githubRepo
    ) {
      primaryPath = await this.workspaceManager.ensureLocalClone(primaryTaskRepo)
      this.repoRepo.upsert({ ...primaryTaskRepo, path: primaryPath })
      log.info(
        { taskId: task.id, repo: primaryTaskRepo.name, path: primaryPath },
        'Repo clonado — no tenía path local',
      )
    }

    log.info(
      {
        taskId: task.id,
        projectId: task.projectId,
        status: task.status,
        agent: agent.id,
        repo: primaryRepoName,
      },
      'Agente seleccionado',
    )

    // ── Workspace lock scope ──────────────────────────────────────────
    // El run usa el WorkspaceManager sólo cuando a) el manager está
    // cableado (producción siempre; tests opt-in) y b) el agente corre en
    // `anthropic-api` (el único provider que recibe el sandbox de worktree —
    // los terminal se quedan en el repo base). El lock cubre todo el run
    // para que un segundo dispatch sobre la misma task falle rápido en
    // `acquireTask` en vez de correr una carrera. El release vive en el
    // `finally` de abajo, así toda salida (éxito, throw, abort) limpia.
    // La decisión en sí (qué provider necesita el sandbox) vive en
    // WorkspaceManager, no acá — es mecánica de workspace.
    const chainNeedsWorkspace = !!(
      this.workspaceManager &&
      primaryPath &&
      needsWorkspace([agent.provider])
    )
    let workspaceLockHeld = false
    if (chainNeedsWorkspace) {
      // May throw `task <id> ya está corriendo` — that's the intended
      // signal to the caller (e.g. a raced dispatcher), so propagate.
      this.workspaceManager!.acquireTask(task.id, primaryPath!)
      workspaceLockHeld = true
    }

    // Mutado por Agent.run para que el finally de abajo pueda intentar la
    // limpieza de un run terminal (async) con worktree, sin importar por qué
    // salida terminó el run.
    const runState: AgentRunState = {}

    try {
      task = await this.agent.run(
        {
          task,
          agentDef: agent,
          manager,
          config,
          runCtx: { ...runCtx, primaryPath },
        },
        runState,
      )

      return true
    } finally {
      // Release the per-task lock exactly once, no matter which exit path
      // (success return, agent throw, upstream abort) got us here.
      // `releaseTask` is idempotent so a duplicate call from a mis-wired
      // test wouldn't harm anything.
      if (workspaceLockHeld) {
        this.workspaceManager!.releaseTask(task.id)
      }

      // Auto-cleanup: remove the terminal worktree when the run is done and
      // there is no work at risk. Applies only to terminal providers (tmux /
      // iterm) that ran with workflow=worktree — anthropic-api worktrees are
      // managed by WorkspaceManager itself. Consolidated in WorkspaceManager
      // (resolve path → check safe → remove-or-warn) so the orchestrator
      // doesn't have to drive that sequence by hand.
      if (runState.terminalWorktreeBranch && primaryPath && this.workspaceManager) {
        await this.workspaceManager.cleanupTerminalWorktree(
          task.id,
          primaryPath,
          runState.terminalWorktreeBranch,
        )
      }
    }
  }
}
