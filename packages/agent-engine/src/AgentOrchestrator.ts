import { join } from 'path'
import type { DispatchOutcome, ITaskSource } from '@ia-flow/issue-sources'
import type { ProviderLimit, Task } from '@ia-flow/shared'
import { Agent, type AgentRunState, type CompilePolicy } from './Agent.js'
import { type WorkspaceManager, needsWorkspace } from './WorkspaceManager.js'
import { type PendingSnapshot, atCap, countRunningByAgent } from './capacity.js'
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
import { type ProviderClassifier, resolveProvider } from './provider-selection.js'
import { resolveRunContext } from './run-context.js'
import { type ResolveVariable } from './variable-resolver.js'

/** Default cuando el caller no inyecta un `ProviderClassifier` (p. ej. tests
 *  con fixtures mínimas): nunca desambigua por texto libre, así que un
 *  agente con >1 provider candidato y ninguno resuelto por `when` falla ese
 *  dispatch en vez de adivinar — mismo comportamiento que tendría con Haiku
 *  indisponible. */
const noClassifier: ProviderClassifier = async () => null

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
    private providers: IProviderRegistry,
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
    // Desambigua entre providers candidatos cuando `agent.provider` es un
    // array y el filtrado por `when` deja >1 elegible con `whenText` — ver
    // provider-selection.ts. Default: nunca desambigua (ver `noClassifier`).
    private classifyProvider: ProviderClassifier = noClassifier,
    // Caps de concurrencia por provider (`ProviderConfig.providerLimits`).
    // Puerto, no import: la config de providers la carga apps/server. Se lee
    // por dispatch — un cambio desde la UI aplica al siguiente sin reiniciar.
    // Default "sin límites" = comportamiento idéntico al de antes.
    private providerLimits: () => Promise<Record<string, ProviderLimit>> = async () => ({}),
    // Snapshot de runs en vuelo para los caps de agente/provider. Default: el
    // registry compartido (ver capacity.ts) — inyectable sólo para tests.
    private pendingSnapshot?: PendingSnapshot,
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

  /** Sonda `IAgentProvider.canAccept` cuando el provider la implementa (hoy:
   *  RemoteAgentProvider contra el /v1/capacity del gateway). Fail-open en
   *  todo lo demás — un provider sin sonda, o un id que el registry no
   *  conoce, no se marca como saturado acá: si no existe, `Agent.run` va a
   *  fallar con un error explícito en vez de que el issue se difiera para
   *  siempre en silencio. */
  private async providerAccepts(providerId: string): Promise<boolean> {
    try {
      const provider = this.providers.get(providerId)
      if (!provider?.canAccept) return true
      return await provider.canAccept()
    } catch {
      return true
    }
  }

  async runAgent(task: Task, manager: ITaskSource): Promise<DispatchOutcome> {
    // Scope the config lookup to the task's project when known — matches how
    // TaskDispatcher fetched it. Legacy callers without projectId fall back to
    // the default project (SqliteProjectConfigRepo.getConfig undefined path).
    const config = await this.configRepo.getConfig(task.projectId)
    if (!config) return 'skipped'

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
    if (!runCtx) return 'skipped'
    let { primaryPath } = runCtx
    const { agent, primaryRepoName, primaryTaskRepo } = runCtx

    // Cap por agente, chequeo autoritativo: `resolveRunContext` acaba de
    // re-seleccionar contra el status fresco, así que ESTE es el agente que
    // realmente correría — el pre-check de TaskDispatcher pudo haber medido
    // otro. Diferir (no skipear) es lo que devuelve el item al backlog.
    const agentRunning = countRunningByAgent(agent.id, this.pendingSnapshot)
    if (atCap(agentRunning, agent.maxConcurrentDispatches)) {
      log.info(
        {
          taskId: task.id,
          agent: agent.id,
          running: agentRunning,
          cap: agent.maxConcurrentDispatches,
        },
        'Agente al tope de runs simultáneos — diferido',
      )
      return 'deferred'
    }

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

    // Resuelve QUÉ provider corre este dispatch — `agent.provider` puede ser
    // un string plano (resuelve directo, sin I/O) o un array de candidatos
    // (puede llamar a Haiku vía `classifyProvider` si queda ambiguo). Ver
    // provider-selection.ts para las reglas de desempate/fallo.
    // Un provider saturado no falla el dispatch: `resolveProvider` ya probó
    // el siguiente candidato y sólo devuelve `saturated` cuando TODOS los
    // elegibles están al tope — ahí el item se difiere y se reintenta al
    // liberarse un slot, en vez de perderse hasta el próximo scan.
    const resolution = await resolveProvider(agent.provider, task, this.classifyProvider, {
      limits: await this.providerLimits(),
      snapshot: this.pendingSnapshot,
      canAccept: (providerId) => this.providerAccepts(providerId),
    })
    if (resolution.kind === 'saturated') {
      log.info(
        { taskId: task.id, agent: agent.id, providers: resolution.providerIds },
        'Todos los providers candidatos al tope — diferido',
      )
      return 'deferred'
    }
    if (resolution.kind === 'none') {
      log.warn(
        { taskId: task.id, agent: agent.id, provider: agent.provider },
        'Ningún provider candidato resuelto — skipping',
      )
      return 'skipped'
    }
    const resolvedProviderId = resolution.providerId

    log.info(
      {
        taskId: task.id,
        projectId: task.projectId,
        status: task.status,
        agent: agent.id,
        provider: resolvedProviderId,
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
      needsWorkspace([resolvedProviderId])
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
          resolvedProviderId,
          manager,
          config,
          runCtx: { ...runCtx, primaryPath },
        },
        runState,
      )

      return 'dispatched'
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
          runState.terminalWorktreePath,
        )
      }
    }
  }
}
