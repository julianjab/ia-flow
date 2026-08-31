// Agent: owns the lifecycle of a single agent dispatch.
//   1. onStart  — marks the task as working in the task-source (setAgentWorking,
//                 onProcess).
//   2-4. runs   — calls the ai-provider (which owns its own tool-call loop —
//                 sync return, or an async tmux session awaited via
//                 waitForFinish) until it finishes or fails.
//   5. finalize — applies the matching exit per the outcome and records the
//                 execution log.
// AgentOrchestrator only resolves which agents apply to a task's status and
// loops calling `Agent.run` for each — this class is the "run one" part.
import { ProviderAtCapacityError, UpstreamAbortError } from '@ia-flow/ai-providers'
import type { PolicyLike, SessionHandle } from '@ia-flow/ai-providers'
import type { ITaskSource } from '@ia-flow/issue-sources'
import { selectCommentWindow } from '@ia-flow/issue-sources'
import type {
  AgentDefinition,
  AgentToolEntry,
  McpServers,
  ProjectConfig,
  Task,
  WorkspacePlan,
  WorkspaceRequest,
} from '@ia-flow/shared'
import {
  EMPTY_WORKSPACE_PLAN,
  ERROR_EXIT,
  SUCCESS_EXIT,
  intersectWritePaths,
} from '@ia-flow/shared'
import { AgentLifecycle } from './AgentLifecycle.js'
import type {
  IBroadcast,
  IExecutionLogRepository,
  IMcpCatalogRepository,
  IProviderRegistry,
  PauseCheckpointPort,
  RunCheckpointPort,
  RunMessagePort,
} from './contract.js'
import { buildFinishPatch, hashPrompt, safeInsertLog, safeUpdateLog } from './execution-log.js'
import { buildGitContext } from './git-context.js'
import {
  type LinkedBranchNamer,
  defaultLinkedBranchNamer,
  resolveLinkedBranch,
} from './linked-branch.js'
import { createLogger } from './logger.js'
import {
  getPendingTask,
  registerPendingTask,
  removePendingTask,
  waitForFinish,
} from './pending-tasks.js'
import type { RunContext } from './run-context.js'
import { resolveExitCommentTarget, selectableExits } from './run-outcome.js'
import { watchSession } from './session-watchdog.js'
import { resolveSystemPromptBlocks } from './system-prompt-blocks.js'
import { type ResolveVariable, resolveVariables } from './variable-resolver.js'
import { hasWriteTools } from './write-access.js'

const log = createLogger('agent')

/** Host-owned policy compiler (packages/tools's policy.ts — coupled to the
 *  tool registry, which is apps/server-internal to wire). Injected so this
 *  package never imports the tools engine directly. */
export type CompilePolicy = (input: { tools?: AgentToolEntry[] }) => PolicyLike | undefined

export interface AgentRunInput {
  task: Task
  /** El agente elegido por `selectAgent` — trae su prompt, provider(s) y outcomes. */
  agentDef: AgentDefinition
  /** El provider ganador, ya resuelto por `resolveProvider` (provider-selection.ts)
   *  contra `agentDef.provider` — que puede ser un string o un array de
   *  candidatos. Esto es SIEMPRE un id concreto, listo para
   *  `this.providers.get(...)`. */
  resolvedProviderId: string
  manager: ITaskSource
  config: ProjectConfig
  /**
   * El checkpoint de una pausa que se está reanudando.
   *
   * Ausente en un dispatch normal. Cuando viene, el provider entra al loop con
   * estos mensajes en vez del prompt.
   */
  resumeCheckpoint?: { messages: unknown[]; reason?: string }
  /** La regla que lanzó este dispatch, si vino de una. Sólo trazabilidad: es
   *  lo que permite dibujar el run sobre su regla en la UI de Pipeline. */
  ruleId?: string
  /** El evento que causó el dispatch. Es la clave que agrupa este run con las
   *  otras acciones del mismo disparo de regla en `execution_logs` — sin él,
   *  la fila del agente no se puede juntar con la notificación que corrió un
   *  segundo antes. */
  eventId?: string
  eventType?: string
  /** Índice de la acción `agent` dentro del `do[]` de su regla. */
  position?: number
  /** El run del agente padre, cuando este run lo lanzó un `run_agent`.
   *  Presente ⇒ es un sub-agente: no cuenta contra el cap de dispatch del
   *  proyecto y no vuelve a tomar el lock de la task (lo tiene el padre). */
  parentRunId?: string
  /** Profundidad de delegación. 0 es el agente de más arriba. */
  agentDepth?: number
  /** Repo layout resuelto por `resolveRunContext` — reemplaza los campos
   *  sueltos (`projectRepos`/`repoPaths`/`primaryPath`/...) que antes se
   *  threadeaban uno por uno; `run` los saca de acá. */
  runCtx: RunContext
}

/**
 * Mutated in place by `run` so a terminal-worktree run is still visible to
 * the orchestrator's cleanup even when `run` throws — su `finally` lo
 * necesita sin importar por qué salida terminó el run. Mirrors the
 * outer-scope variable AgentOrchestrator used to mutate directly before this
 * class existed.
 */
export interface AgentRunState {
  /** El provider dijo "estoy al tope" DURANTE el run (503 del agent-host remoto
   *  — ver ProviderAtCapacityError). No es un fallo: el orquestador lo
   *  traduce a `deferred` para que el issue se reintente en vez de que corra
   *  la salida de error del agente. */
  deferredAtCapacity?: boolean
  /** Lo que produjo el run. Lo lee `runSubAgent` para devolvérselo al padre
   *  como `tool_result` — un dispatch normal lo ignora, porque su resultado
   *  ya viaja por los outcomes y los comentarios. */
  output?: string
  /**
   * Limpieza del terreno que preparó el provider, si lo pidió (hoy: el
   * worktree de un run terminal). El orquestador la invoca en su `finally`,
   * sin saber qué hace ni para qué provider — antes ese `finally` tenía
   * cableado el caso particular de tmux/iterm.
   */
  releaseWorkspace?: () => Promise<void>
  /**
   * El id del run, para que el orquestador pueda limpiar en su `finally` lo
   * que quedó indexado por run — hoy, el checkpoint.
   *
   * Lo escribe `Agent.run` en cuanto lo genera: el orquestador no puede
   * derivarlo, y sin esto el checkpoint de un run que terminó se quedaría en
   * disco para siempre.
   */
  runId?: string
}

// Replaces ${VAR} placeholders in every string value inside an McpServers map
// with the matching Bun.env entry. Empty / unset vars collapse to '', so the
// downstream provider sees a literal Authorization header without the token,
// which fails loudly at the API instead of leaking a raw placeholder.
// Whether `prompt` references `{{<variablePath>}}` — used to gate marking
// `{{task.comments}}` as read (see Agent.run below). Matches the SAME regex
// and trim as resolveVariables (variable-resolver.ts) so this can't drift
// out of sync with what actually resolves: a plain `.includes('{{task.
// comments}}')` check would miss `{{ task.comments }}` (extra whitespace,
// which resolveVariables happily trims and resolves), silently leaving that
// agent's comments unmarked forever.
export function promptReferencesVariable(prompt: string, variablePath: string): boolean {
  return Array.from(prompt.matchAll(/\{\{([^}]+)\}\}/g)).some((m) => m[1].trim() === variablePath)
}

/**
 * Resuelve un `${VAR}` de una config de MCP. Default: el env del proceso.
 *
 * Es inyectable porque no todos los secretos viven en el env: la credencial de
 * GitHub puede venir de una App y rotar cada hora, y el MCP oficial de GitHub
 * la recibe justamente por `${GITHUB_TOKEN}` (ver la migracion 018). Sin este
 * hook, un agente con ese MCP arrancaria con el token que habia en el env al
 * boot — vacio, o vencido.
 *
 * El host lo cablea en su composition root; este paquete sigue sin saber que
 * es una GitHub App.
 */
export type SecretResolver = (name: string) => Promise<string | undefined>

let resolveSecret: SecretResolver = async (name) => Bun.env[name]

export function setSecretResolver(fn: SecretResolver): void {
  resolveSecret = fn
}

async function interpolateMcpServers(servers: McpServers): Promise<McpServers> {
  const walk = async (val: unknown): Promise<unknown> => {
    if (typeof val === 'string') {
      // Se resuelven de a uno y en serie: son un punado por config y cada uno
      // puede costar una renovacion de token; paralelizar aca no compra nada.
      const names = [...val.matchAll(/\$\{([A-Z0-9_]+)\}/gi)].map((m) => m[1])
      let out = val
      for (const name of names) {
        const value = (await resolveSecret(name)) ?? ''
        out = out.replaceAll('${' + name + '}', value)
      }
      return out
    }
    if (Array.isArray(val)) return Promise.all(val.map(walk))
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(val)) out[k] = await walk(v)
      return out
    }
    return val
  }
  return (await walk(servers)) as McpServers
}

export class Agent {
  constructor(
    private providers: IProviderRegistry,
    private broadcast: IBroadcast,
    private mcpCatalogRepo?: IMcpCatalogRepository,
    private executionLogRepo?: IExecutionLogRepository,
    private compilePolicyPort?: CompilePolicy,
    private linkedBranchNamer: LinkedBranchNamer = defaultLinkedBranchNamer,
    private resolveVariable: ResolveVariable = () => undefined,
    // Cola de mensajes inyectados en un run en curso. Ausente = nadie inyecta
    // nada y el loop no drena, que es el comportamiento previo a este canal.
    private runMessages?: RunMessagePort,
    // Cuelga el checkpoint de la espera que la tool ya armó. Ausente = las
    // pausas no persisten estado y el run se comporta como uno truncado.
    private pausePort?: PauseCheckpointPort,
    // Persiste dónde va el run en cada vuelta. Ausente = no se guarda nada y
    // un reinicio se lleva el trabajo, que es el comportamiento previo.
    private runCheckpoints?: RunCheckpointPort,
  ) {}

  async resolveMcpCatalog(agentDef: {
    id?: string
    mcpCatalogIds?: string[]
    providerConfig?: Record<string, unknown>
  }): Promise<Record<string, unknown> | undefined> {
    const ids = agentDef.mcpCatalogIds ?? []
    if (!ids.length || !this.mcpCatalogRepo) return agentDef.providerConfig
    const merged: McpServers = {}
    for (const id of ids) {
      const entry = this.mcpCatalogRepo.get(id)
      if (!entry) {
        log.warn({ agentId: agentDef.id, mcpId: id }, 'MCP catalog entry not found — skipping')
        continue
      }
      merged[entry.id] = entry.config
    }
    // Inline mcpServers (per-agent overrides) take precedence over catalog entries.
    const inlineServers = (agentDef.providerConfig?.mcpServers as McpServers | undefined) ?? {}
    const mcpServers: McpServers = await interpolateMcpServers({ ...merged, ...inlineServers })
    if (!Object.keys(mcpServers).length) return agentDef.providerConfig
    return { ...(agentDef.providerConfig ?? {}), mcpServers }
  }

  /**
   * Runs one agent dispatch end-to-end. Returns the updated task on every
   * normal exit path (cancelled, upstream-abort, truncated, moved-by-tool,
   * success). Throws only for a genuine failure (after applying the error exit) so
   * the orchestrator's chain stops — matching the pre-extraction behaviour
   * where such an error propagated out of `runAgent`.
   */
  async run(input: AgentRunInput, runState: AgentRunState): Promise<Task> {
    const { agentDef, resolvedProviderId, manager, config, runCtx } = input
    const { projectRepos, repoPaths, primaryPath, primaryRepoName, primaryWorkflow } = runCtx
    let task = input.task
    const lifecycle = new AgentLifecycle(manager, this.broadcast)

    // Acota los comentarios a los posteriores al último que escribió ESTE
    // agente: "qué pasó desde que terminé la última vez". Ver
    // selectCommentWindow (@ia-flow/issue-sources) para por qué ése es el
    // corte y no "los del engine" vs "los humanos".
    //
    // Acá y no en TaskDispatcher: su match puede no ser el agente que termina
    // corriendo (el orquestador re-selecciona contra el status fresco antes de
    // llamar acá), y filtrar con el agente equivocado daría la ventana
    // equivocada. Acá `agentDef` ya es el definitivo — el mismo criterio por el
    // que markCommentsUsed vive abajo en vez de en el dispatcher, y lo que hace
    // que se marque exactamente lo que este run leyó.
    if (task.comments?.length) {
      task = { ...task, comments: selectCommentWindow(task.comments, agentDef.id) }
    }

    // PASO 1 — onStart: actualiza el task-source antes de llamar al provider.
    task = await lifecycle.start(task, agentDef)

    // Snapshot the pre-run status so both the success and error branches
    // below can decide whether a tool call already moved the task (in
    // which case we don't clobber it with the default exit). This is
    // captured AFTER onProcess above, on purpose — it seeds both
    // `pending.initialStatus` (frozen — see registerPendingTask below and
    // its field doc in pending-tasks.ts) and `pending.reconciliationStatus`
    // (mutable, resynced by set_task_field mid-run). Capturing it post-
    // onProcess means SourceIssueManager's divergence-reconciliation loop
    // (packages/issue-sources/src/dispatch/source-issue-manager.ts), which
    // compares `reconciliationStatus` against the source's live status
    // every scan cycle, can never see this run's own onProcess as "drift" —
    // load-bearing ordering, see the comment on that loop.
    const initialStatus = task.status
    // Single correlation id per run: used as the execution_logs PK and
    // handed to the provider so every log line for this run carries the
    // same `runId`.
    const runId = crypto.randomUUID().slice(0, 8)
    // Se publica en el estado compartido para que el `finally` del orquestador
    // pueda borrar el checkpoint de este run sin poder derivar su id.
    runState.runId = runId
    const logId = runId
    // Un sub-agente corre sobre la MISMA task que su padre, así que no puede
    // compartir la clave del registry: registrarlo pisaría la entrada del
    // padre y con ella su cancel, su executionId y sus tools de cierre.
    //
    // Que un `getPendingTask(task.id)` desde el hijo resuelva al PADRE es lo
    // correcto y no un efecto colateral: el dueño del ciclo de vida de la
    // tarea es el padre. El hijo devuelve su resultado por `tool_result`.
    const registryKey = input.parentRunId ? `${task.id}#sub:${runId}` : task.id
    // Telemetry constants for this run, hoisted above the try so the catch
    // branches record the same columns the happy paths do — a failed run is
    // exactly the one whose duration and tool counters matter.
    // `startedAtMs` is the wall clock the duration is measured against (the
    // row's own `startedAt` is an ISO string written for humans).
    const startedAtMs = Date.now()
    const toolsAvailable = (agentDef.tools ?? []).length
    // Identifies the exact prompt this run executed, so a later regression
    // can be attributed to a prompt edit rather than to the agent id alone.
    // Only known once the prompt is resolved inside the try — a run that
    // throws before that point legitimately has none.
    let agentPromptHash: string | undefined
    // Declared outside the try so the catch below can read
    // `controller.signal.aborted` to disambiguate our manual cancel from an
    // upstream abort.
    const controller = new AbortController()

    try {
      // PASOS 2-4 — arma el ProviderInput y llama al ai-provider (que posee
      // su propio loop de tool-calls) hasta que termina o falla.
      const projectContext: Record<string, string> = {
        ...((config.project as Record<string, string> | undefined) ?? {}),
        ...(manager.getProjectContext?.() ?? {}),
      }
      const resolvedPrompt = resolveVariables(
        agentDef.prompt,
        { task, variables: agentDef.variables, project: projectContext, projectRepos },
        this.resolveVariable,
      )

      const systemPromptBlocks = resolveSystemPromptBlocks(agentDef, config)

      const provider = this.providers.get(resolvedProviderId)
      // Git context de motor: preprendemos un bloque markdown al prompt del
      // agente indicando qué branch/worktree/repo tiene disponible, así los
      // prompts de agentes NO deciden nombre de branch ni si crear worktree.
      // buildGitContext recibe el IAgentProvider completo y decide la rama de
      // comportamiento por provider.kind (sync/async), no por su id.
      const sourceToolContext = manager.getSourceToolContext?.()

      // Auto-link branch (see resolveLinkedBranch for the gating rules).
      task = await resolveLinkedBranch({
        task,
        agentDef,
        resolvedProviderId,
        manager,
        linkedBranchNamer: this.linkedBranchNamer,
      })

      // ── Workspace ────────────────────────────────────────────────────
      // El engine declara la INTENCIÓN (qué repos, qué branch, si el agente
      // escribe) y el provider devuelve el terreno concreto. Acá ya no hay
      // ningún `if (providerId === 'anthropic-api')`: cada provider sabe si
      // necesita un worktree, un checkout in-place o nada, y —clave para los
      // remotos— lo resuelve sobre SU disco.
      const workspaceRequest: WorkspaceRequest = {
        taskId: task.id,
        taskTitle: task.title,
        issueNumber: task.issueNumber,
        runId,
        step: 'implement',
        repos: projectRepos.map((r) => ({
          name: r.name,
          path: repoPaths[r.name],
          githubOwner: r.githubOwner,
          githubRepo: r.githubRepo,
        })),
        primaryRepo: primaryRepoName,
        branch: task.branch,
        workflow: primaryWorkflow,
        needsWrite: hasWriteTools({ tools: agentDef.tools }),
      }
      const plan: WorkspacePlan =
        (await provider.prepareWorkspace?.(workspaceRequest)) ?? EMPTY_WORKSPACE_PLAN

      // El plan sólo REEMPLAZA los repos que tocó (típicamente el primario,
      // remapeado a su worktree); el resto del proyecto sigue visible para
      // las fs tools.
      const effectiveRepoPaths = { ...repoPaths, ...plan.repoPaths }
      // El permiso de escritura NO es del provider: acá se intersecta lo que
      // propuso contra lo que el agente declaró en sus `tools[]`.
      const effectiveWritePaths = intersectWritePaths(plan.writePaths, workspaceRequest.needsWrite)
      const effectiveCwd = plan.cwd ?? primaryPath
      // La branch que el provider terminó usando (linked branch de GitHub si
      // `resolveLinkedBranch` ya la seteó, o el fallback `task/<id>`) se
      // refleja de vuelta en el Task.
      if (plan.branch) task = { ...task, branch: plan.branch }
      // La limpieza viaja con el plan; el orquestador la corre en su
      // `finally` sin saber de qué provider vino.
      runState.releaseWorkspace = plan.release

      // Prepend engine-provided git context to the resolved prompt.
      const gitContext = await buildGitContext({
        taskId: task.id,
        provider,
        cwd: effectiveCwd,
        repoBasePath: primaryPath,
        workflow: primaryWorkflow,
        worktreePath: plan.worktreePath,
        hasWriteAccess: workspaceRequest.needsWrite,
        branch: task.branch,
      })
      const finalPrompt = gitContext ? `${gitContext}\n\n${resolvedPrompt}` : resolvedPrompt

      // Cancellation plumbing: the polling manager calls entry.cancel() when
      // it detects the source-side status has drifted from the one at
      // dispatch time (manual gate). For sync providers we abort the fetch;
      // for tmux we kill the session once it's known.

      // Register before run so in-process tools can resolve the manager
      registerPendingTask(registryKey, {
        task,
        manager,
        exits: agentDef.exits,
        commentTarget: agentDef.comment,
        broadcast: (msg: object) => this.broadcast.send(msg),
        initialStatus,
        // Starts equal to initialStatus, but unlike it gets resynced by
        // set_task_field when the agent moves its own task mid-run — see
        // the field doc on PendingTask.reconciliationStatus.
        reconciliationStatus: initialStatus,
        runId,
        agentId: agentDef.id,
        agentName: agentDef.id,
        providerId: resolvedProviderId,
        projectId: task.projectId,
        // Identidad de la fila de execution_logs de ESTE run. La usa la
        // reconciliación de arranque para distinguir una fila viva de una
        // colgada de un proceso anterior sobre la misma tarea.
        executionId: logId,
        ruleId: input.ruleId,
        parentRunId: input.parentRunId,
        agentDepth: input.agentDepth ?? 0,
        cancel: async () => {
          const entryPending = getPendingTask(registryKey)
          if (entryPending) entryPending.cancelled = true
          controller.abort()
          try {
            await entryPending?.killSession?.()
          } catch {}
          try {
            await manager.setAgentWorking(task, false)
          } catch {}
        },
      })

      agentPromptHash = hashPrompt(finalPrompt, JSON.stringify(systemPromptBlocks ?? null))

      safeInsertLog(this.executionLogRepo, {
        id: logId,
        projectId: task.projectId ?? '',
        taskId: task.id,
        taskTitle: task.title,
        agentId: agentDef.id,
        providerId: resolvedProviderId,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outcome: null,
        errorMsg: null,
        stopReason: null,
        runId,
        agentPromptHash,
        // Contrato de cierre: con esto, la fila alcanza para cerrar el run
        // aunque el registry en memoria ya no exista (reinicio del proceso,
        // watchdog que soltó la entrada). Ver la migración 048.
        initialStatus,
        exits: agentDef.exits ?? null,
        // La causa, sobre la fila (migración 065). Antes vivía sólo en el
        // registry en memoria, así que un reinicio dejaba el run sin saber qué
        // lo había disparado ni de quién colgaba.
        kind: 'agent',
        ruleId: input.ruleId ?? null,
        eventId: input.eventId ?? null,
        eventType: input.eventType ?? null,
        position: input.position ?? null,
        parentId: input.parentRunId ?? null,
        // Foto de quién tenía el issue cuando arrancó este run — es lo que
        // permite filtrar ejecuciones por usuario después (migración 057). Se
        // congela acá y no se relee al cerrar por lo mismo que onFinish/onError:
        // el issue puede cambiar de dueño mientras el agente trabaja.
        assignees: task.assignees ?? null,
      })

      const output = await provider.run({
        step: 'implement',
        agentId: agentDef.id,
        projectId: task.projectId,
        // Lo que ve `run_agent` para frenar una cadena circular de delegación.
        agentDepth: input.agentDepth ?? 0,
        runId,
        taskId: task.id,
        taskTitle: task.title,
        taskDescription: task.description,
        taskType: task.type,
        issueNumber: task.issueNumber,
        repos: task.repos,
        assignees: task.assignees,
        repoPaths: effectiveRepoPaths,
        workspace: workspaceRequest,
        prompt: finalPrompt,
        // Un run que reanuda una pausa entra con la conversación que el
        // checkpoint guardó, no con el prompt: retomar desde el prompt
        // perdería todo lo que el agente ya había averiguado, que es lo que
        // la pausa existe para conservar. El prompt igual viaja — lo usan los
        // providers de terminal, que no tienen checkpoint.
        resumeMessages: input.resumeCheckpoint?.messages,
        systemPromptBlocks,
        // Async/terminal providers render this as a curl appendix (they don't
        // consume `policy`), so they only need the plain tool names. Default
        // to `[]` (not `undefined`) when the agent declares no `tools:` —
        // `resolveTools` treats `undefined` as "no filter" (catalog/listing
        // callers) and would leak every registered tool into the curl
        // appendix instead of just the internal lifecycle ones.
        tools: (agentDef.tools ?? []).map((t) => (typeof t === 'string' ? t : t.name)),
        selectableExits: selectableExits(agentDef.exits),
        providerConfig: await this.resolveMcpCatalog(agentDef),
        sourceToolContext,
        cwd: effectiveCwd,
        workflow: primaryWorkflow,
        branch: task.branch,
        writePaths: effectiveWritePaths,
        policy: this.compilePolicyPort?.({ tools: agentDef.tools }),
        signal: controller.signal,
        // La cola de mensajes de ESTA task. Sin port cableado (tests, un
        // proceso sin store) los hooks quedan `undefined` y el loop no drena
        // nada, que es el comportamiento de siempre.
        drainMessages: this.runMessages ? () => this.runMessages!.pending(task.id) : undefined,
        onMessagesDelivered: this.runMessages
          ? (ids) => this.runMessages!.markDelivered(ids, runId)
          : undefined,
        // Dónde va el run, persistido por vuelta. El engine sólo provee el
        // canal: qué se guarda lo decide el provider, y uno de terminal ni
        // siquiera lo llama.
        saveCheckpoint: this.runCheckpoints
          ? (state) =>
              this.runCheckpoints!.save({
                runId,
                taskId: task.id,
                agentId: agentDef.id,
                projectId: task.projectId,
                state,
              })
          : undefined,
      })

      // Mark any human comments this run read as "used" so they don't get
      // re-injected into `{{task.comments}}` on a future re-dispatch of the
      // same task (e.g. build → review → build after a fail_task retry).
      // Deliberately placed AFTER provider.run resolves — for both sync and
      // async providers that means the model genuinely received `finalPrompt`
      // (including the rendered comments), not just that TaskDispatcher
      // loaded them. Gated on THIS run's actual agentDef (post re-selection,
      // not TaskDispatcher's pre-dispatch match) so marking always reflects
      // who really read them. Best-effort: a source without
      // markCommentsUsed just keeps the old "shows up every time" behavior.
      // TaskCommentSchema.id is optional (sources without markCommentsUsed
      // never populate it) — narrow to the ones a source can actually mark.
      const commentsWithId = (task.comments ?? []).filter(
        (c): c is { id: string; body: string; created_at: string } => c.id != null,
      )
      if (commentsWithId.length && promptReferencesVariable(agentDef.prompt, 'task.comments')) {
        await manager.markCommentsUsed?.(commentsWithId).catch((err) => {
          log.warn(
            { taskId: task.id, err: (err as Error).message },
            'markCommentsUsed threw — comments will be re-loaded next dispatch',
          )
        })
      }

      // PASO 5 — finaliza según el resultado.
      runState.output = output.content

      if (output.mode === 'tmux') {
        // Wire the provider-agnostic session handle: persist its coordinates
        // so the row in execution_logs can be looked up / cancelled later,
        // register close() as killSession, and start a liveness watchdog
        // that finalizes the run if the user closes the tab manually.
        let sessionHandle: SessionHandle | undefined
        let unwatchSessionLocal: (() => void) | undefined
        if (output.session) {
          const handle = output.session
          sessionHandle = handle
          const entryPending = getPendingTask(registryKey)
          if (entryPending) {
            entryPending.killSession = () => handle.close()
            const unwatch = watchSession(handle, (reason) => {
              // Dos motivos, dos consecuencias — pero ninguno mata la sesión:
              // el agente puede seguir trabajando del otro lado y su cierre
              // tardío igual aterriza, porque los tools de cierre rehidratan
              // el run desde `execution_logs`.
              //
              // `liveness-unknown` (no pudimos preguntar: el agent-host que la
              // hospeda reinició, AppleScript se colgó) suelta la entrada sin
              // aplicar transición. Soltarla es obligatorio: `Agent.run` está
              // bloqueado en `waitForFinish`, que sólo resuelve desde
              // `removePendingTask` — dejarla puesta congelaría el lock de la
              // task y los slots del agente, el proyecto y el provider hasta
              // el próximo reinicio (con `maxConcurrentDispatches: 1`, ese
              // agente no vuelve a correr nunca).
              if (reason === 'liveness-unknown') {
                log.warn(
                  { taskId: task.id, sessionKind: handle.kind, sessionId: handle.id },
                  'Liveness desconocida sostenida — suelto el run sin transición; su cierre igual se acepta',
                )
                removePendingTask(registryKey, {
                  cancelled: true,
                  reason: 'watchdog: liveness desconocida sostenida — sin confirmar muerte',
                })
                manager.setAgentWorking(task, false).catch(() => {})
                return
              }
              log.warn(
                { taskId: task.id, sessionKind: handle.kind, sessionId: handle.id },
                'Session died before agent finalized — cancelling run',
              )
              removePendingTask(registryKey, {
                cancelled: true,
                reason: 'watchdog: sesión confirmada muerta',
              })
              manager.setAgentWorking(task, false).catch(() => {})
            })
            entryPending.unwatchSession = unwatch
            unwatchSessionLocal = unwatch
          }
          try {
            this.executionLogRepo?.update(logId, { sessionKind: handle.kind, sessionId: handle.id })
          } catch (logErr) {
            log.warn({ err: logErr }, 'Failed to persist session metadata to execution log')
          }
        }
        log.info(
          { taskId: task.id, sessionKind: output.session?.kind, sessionId: output.session?.id },
          'async session started — awaiting tool callback',
        )

        // Block until the agent actually finishes (via complete_task /
        // fail_task / cancel) so the orchestrator's loop can't start a
        // second agent's session in parallel on the same task.
        const finish = await waitForFinish(task.id)
        unwatchSessionLocal?.()
        if (sessionHandle && !finish?.cancelled) {
          try {
            await sessionHandle.close()
          } catch (closeErr) {
            log.warn(
              { err: closeErr, sessionKind: sessionHandle.kind, sessionId: sessionHandle.id },
              'Failed to close terminal session after run finished',
            )
          }
        }
        if (finish) {
          task = finish.task
          if (finish.cancelled) {
            log.info(
              { taskId: task.id, agent: agentDef.id },
              'Async agent run cancelled — skipping transition',
            )
            safeUpdateLog(this.executionLogRepo, logId, {
              ...buildFinishPatch({
                outcome: 'cancelled',
                startedAtMs,
                runId,
                metrics: output.metrics,
                toolsAvailable,
                agentPromptHash,
              }),
              finishedAt: new Date().toISOString(),
              outcome: 'cancelled',
              errorMsg: finish.reason,
            })
            return task
          }
          // complete_task / fail_task have already applied their transitions
          // and cleared the working flag; the only remaining job is to
          // record success in the execution log. `finalizedByTool` queda
          // marcado para que un cierre repetido —la misma sesión
          // reintentando después de un reinicio— se reconozca como duplicado
          // en vez de volver a comentar y transicionar.
          safeUpdateLog(this.executionLogRepo, logId, {
            finalizedByTool: finish.finalizedByTool === true,
            ...buildFinishPatch({
              outcome: 'success',
              stopReason: output.stopReason,
              startedAtMs,
              runId,
              metrics: output.metrics,
              toolsAvailable,
              agentPromptHash,
            }),
            finishedAt: new Date().toISOString(),
            outcome: 'success',
            stopReason: output.stopReason,
          })
        }
      } else {
        // Sync (API) — pick up any task mutations from in-process tool calls, then clean up
        const pendingAfterRun = getPendingTask(registryKey)
        const cancelled = pendingAfterRun?.cancelled === true
        const finalizedByTool = pendingAfterRun === undefined
        // La salida que el agente eligió con `select_exit`. Se lee ANTES de
        // soltar la entrada: en sync el que cierra es el engine, así que es lo
        // único que sobrevive del run para decidir por qué arista cerrar.
        const chosenExit = pendingAfterRun?.chosenExit
        task = pendingAfterRun?.task ?? task
        removePendingTask(registryKey)

        if (cancelled) {
          log.info(
            { taskId: task.id, agent: agentDef.id },
            'Agent run cancelled — skipping transition',
          )
          safeUpdateLog(this.executionLogRepo, logId, {
            ...buildFinishPatch({
              outcome: 'cancelled',
              startedAtMs,
              runId,
              metrics: output.metrics,
              toolsAvailable,
              agentPromptHash,
            }),
            finishedAt: new Date().toISOString(),
            outcome: 'cancelled',
          })
          return task
        }

        // If a tool call moved the task while the loop ran, respect that
        // decision — the default exit would clobber it.
        const freshPostStatus = (await manager.getCurrentStatus?.(task)) ?? task.status
        if (freshPostStatus !== task.status) {
          task = { ...task, status: freshPostStatus }
        }
        if (finalizedByTool || task.status.toLowerCase() !== initialStatus.toLowerCase()) {
          log.info(
            { taskId: task.id, agent: agentDef.id, from: initialStatus, to: task.status },
            'Task moved by tool call during run — skipping default transition',
          )
          safeUpdateLog(this.executionLogRepo, logId, {
            // Se persiste igual que en la rama async: es lo que hace que un
            // cierre TARDÍO (otra sesión, otro proceso, un reintento después
            // de un reinicio) se reconozca como duplicado en el rehidratador
            // (`closedByTool`, apps/server/src/adapters/pending-task-rehydrator.ts)
            // en vez de reconstruir la ejecución como si siguiera abierta y
            // volver a comentar y transicionar. Faltaba sólo acá, así que un
            // run sync cerrado por tool quedaba marcado como "no cerrado por
            // tool" y era el único que podía duplicarse.
            finalizedByTool,
            ...buildFinishPatch({
              outcome: 'success',
              stopReason: output.stopReason,
              startedAtMs,
              runId,
              metrics: output.metrics,
              toolsAvailable,
              agentPromptHash,
            }),
            finishedAt: new Date().toISOString(),
            outcome: 'success',
            stopReason: output.stopReason,
          })
          try {
            await manager.setAgentWorking(task, false)
          } catch {}
          return task
        }

        // Pausa: una tool pidió el corte y el loop devolvió la conversación.
        // Se resuelve ANTES que `truncated` porque también es un final "sin
        // terminar", pero de los dos es el único deliberado — tratarlo como
        // truncado revertiría la task y publicaría un aviso de fallo por algo
        // que el agente hizo a propósito.
        if (output.checkpoint) {
          log.info(
            { taskId: task.id, agent: agentDef.id, reason: output.checkpoint.reason },
            'Run pausado — el checkpoint queda colgado de la espera',
          )
          // El flag `working` NO se limpia: la task sigue en manos de este
          // agente, sólo que dormido. Limpiarlo dejaría que el próximo scan la
          // tome con otro agente y pise el worktree del pausado.
          await this.pausePort?.attachCheckpoint(task.id, output.checkpoint)
          safeUpdateLog(this.executionLogRepo, logId, {
            ...buildFinishPatch({
              outcome: 'success',
              stopReason: 'paused',
              startedAtMs,
              runId,
              metrics: output.metrics,
              toolsAvailable,
              agentPromptHash,
            }),
            finishedAt: new Date().toISOString(),
            outcome: 'success',
            stopReason: 'paused',
          })
          return task
        }

        task = await manager.setAgentWorking(task, false)

        if (output.truncated) {
          // Recoverable pause (task budget exhausted or safety cap). Don't
          // run the success exit — post a progress notice and, if there's
          // an error exit, use it to revert so the user can retry.
          log.warn(
            { taskId: task.id, agent: agentDef.id, stopReason: output.stopReason ?? 'unknown' },
            'Agent run truncated — posting pause notice',
          )
          safeUpdateLog(this.executionLogRepo, logId, {
            ...buildFinishPatch({
              outcome: 'truncated',
              stopReason: output.stopReason,
              errorMsg: output.rawResponse ?? null,
              startedAtMs,
              runId,
              metrics: output.metrics,
              toolsAvailable,
              agentPromptHash,
            }),
            finishedAt: new Date().toISOString(),
            outcome: 'truncated',
            stopReason: output.stopReason,
            // Full raw API response for the call that got cut short — the
            // short stopReason alone doesn't say why (usage, partial
            // content, a stop_sequence, …). Sync-only: output.rawResponse
            // is set by executeLoop (packages/tools), which async providers
            // don't run. Reuses errorMsg rather than a new column — it's
            // already surfaced in the executions drawer and was otherwise
            // always null for a truncated outcome.
            errorMsg: output.rawResponse ?? null,
          })
          // `refusal` isn't a budget/iteration pause — Claude declined to
          // respond on safety grounds — so re-running the same agent as-is
          // is unlikely to just pick up where it left off. Say so instead
          // of implying "move it back and it'll continue".
          const notice =
            output.stopReason === 'refusal'
              ? [
                  `# ${agentDef.id} · 🔴 rechazado`,
                  '',
                  'El modelo se negó a responder por políticas de seguridad — no es un límite de',
                  'budget ni de iteraciones. Revisá el prompt/contexto de esta tarea antes de',
                  'reintentar; volver a correr el mismo agente sin cambios probablemente repita',
                  'el rechazo.',
                ].join('\n')
              : [
                  `# ${agentDef.id} · 🟡 pausado`,
                  '',
                  `**Razón**: ${output.stopReason ?? 'unknown'}`,
                  '',
                  'Avancé pero no terminé. Los cambios ya aplicados quedan persistidos.',
                  'Mueve la tarea al status anterior para continuar.',
                ].join('\n')
          await manager.postComment?.(
            task,
            notice,
            resolveExitCommentTarget(
              { exits: agentDef.exits, commentTarget: agentDef.comment },
              ERROR_EXIT,
            ),
          )
          task = await lifecycle.fail(task, agentDef, `truncated:${output.stopReason ?? 'unknown'}`)
        } else if (agentDef.exits) {
          // Sync agents don't call complete_task (async-only — see
          // resolveExecutableTool in packages/tools) so nothing has posted a
          // summary of the run yet. Post the model's own final text as the
          // completion comment — the sync equivalent of what complete_task's
          // formatCompleteComment does for async, without requiring a tool
          // call the model was never offered.
          if (output.content.trim()) {
            await manager.postComment?.(
              task,
              `# ${agentDef.id}\n\n${output.content.trim()}`,
              resolveExitCommentTarget(
                { exits: agentDef.exits, chosenExit, commentTarget: agentDef.comment },
                SUCCESS_EXIT,
              ),
            )
          }
          safeUpdateLog(this.executionLogRepo, logId, {
            ...buildFinishPatch({
              outcome: 'success',
              stopReason: output.stopReason,
              startedAtMs,
              runId,
              metrics: output.metrics,
              toolsAvailable,
              agentPromptHash,
            }),
            finishedAt: new Date().toISOString(),
            outcome: 'success',
            stopReason: output.stopReason,
          })
          task = await lifecycle.end(task, { exits: agentDef.exits, chosenExit })
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const pendingEntry = getPendingTask(registryKey)
      // Authoritative signal for "we cancelled it ourselves": the polling
      // divergence gate and graceful shutdown both go through entry.cancel().
      const explicitlyCancelled = pendingEntry?.cancelled === true || controller.signal.aborted
      // Upstream abort: the provider's fetch died on its own with no user
      // cancel involved.
      const upstreamAbort = err instanceof UpstreamAbortError && !explicitlyCancelled
      // El provider quedó al tope entre la sonda de admisión y el run — ver
      // ProviderAtCapacityError. Se maneja acá arriba, antes del camino de
      // error, porque justamente NO es un error: nada del trabajo se intentó.
      const atCapacity = err instanceof ProviderAtCapacityError && !explicitlyCancelled
      task = pendingEntry?.task ?? task
      removePendingTask(registryKey)

      if (atCapacity) {
        runState.deferredAtCapacity = true
        log.info(
          {
            event: 'agent.deferred',
            taskId: task.id,
            agent: agentDef.id,
            runId,
            reason: 'provider-at-capacity',
            retryAfterMs: (err as ProviderAtCapacityError).retryAfterMs,
            err: errMsg,
          },
          'El provider estaba al tope al arrancar el run — diferido, sin salida de error',
        )
        // `cancelled`, no `error`: el run nunca llegó a hacer nada, así que
        // contarlo como fallo ensuciaría las métricas y la clasificación de
        // fallas. Mismo criterio que el upstream abort de abajo.
        safeUpdateLog(this.executionLogRepo, logId, {
          ...buildFinishPatch({
            outcome: 'cancelled',
            errorMsg: `provider-at-capacity: ${errMsg}`,
            startedAtMs,
            runId,
            metrics: undefined,
            toolsAvailable,
            agentPromptHash,
          }),
          finishedAt: new Date().toISOString(),
          outcome: 'cancelled',
          errorMsg: `provider-at-capacity: ${errMsg}`,
        })
        // Sin esto el issue queda con el flag de "agente trabajando" puesto y
        // el próximo scan lo saltea — quedaría trabado justo cuando lo que
        // queremos es que se reintente.
        try {
          task = await manager.setAgentWorking(task, false)
        } catch {}
        return task
      }

      if (explicitlyCancelled) {
        log.info(
          {
            event: 'agent.cancelled',
            taskId: task.id,
            agent: agentDef.id,
            runId,
            reason: 'status-divergence',
          },
          'Agent run cancelled by status divergence',
        )
        safeUpdateLog(this.executionLogRepo, logId, {
          ...buildFinishPatch({
            outcome: 'cancelled',
            startedAtMs,
            runId,
            metrics: undefined,
            toolsAvailable,
            agentPromptHash,
          }),
          finishedAt: new Date().toISOString(),
          outcome: 'cancelled',
        })
        return task
      }

      if (upstreamAbort) {
        log.warn(
          {
            event: 'agent.aborted',
            taskId: task.id,
            agent: agentDef.id,
            runId,
            reason: 'upstream-abort',
            err: errMsg,
          },
          'Agent run aborted by upstream API (network/stream stall)',
        )
        safeUpdateLog(this.executionLogRepo, logId, {
          ...buildFinishPatch({
            outcome: 'cancelled',
            errorMsg: `upstream-abort: ${errMsg}`,
            startedAtMs,
            runId,
            metrics: undefined,
            toolsAvailable,
            agentPromptHash,
          }),
          finishedAt: new Date().toISOString(),
          outcome: 'cancelled',
          errorMsg: `upstream-abort: ${errMsg}`,
        })
        try {
          task = await manager.setAgentWorking(task, false)
        } catch {}
        return task
      }

      // If a tool already moved the task before the throw, respect it —
      // don't re-apply the error exit on top of the intentional destination.
      try {
        const freshErrStatus = await manager.getCurrentStatus?.(task)
        if (freshErrStatus && freshErrStatus !== task.status) {
          task = { ...task, status: freshErrStatus }
        }
      } catch {
        // Fresh read failed (network, auth, …) — fall back to the in-memory
        // status rather than swallow the original throw with a secondary one.
      }
      if (task.status.toLowerCase() !== initialStatus.toLowerCase()) {
        log.info(
          { taskId: task.id, from: initialStatus, to: task.status, err: errMsg },
          'Task moved by tool call before error surfaced — skipping the error exit',
        )
        safeUpdateLog(this.executionLogRepo, logId, {
          ...buildFinishPatch({
            outcome: 'error',
            errorMsg: errMsg,
            startedAtMs,
            runId,
            metrics: undefined,
            toolsAvailable,
            agentPromptHash,
          }),
          finishedAt: new Date().toISOString(),
          outcome: 'error',
          errorMsg: errMsg,
        })
        try {
          await manager.setAgentWorking(task, false)
        } catch {}
        throw err
      }

      log.error(
        { event: 'agent.error', taskId: task.id, agent: agentDef.id, err: errMsg },
        'Agent run failed',
      )
      safeUpdateLog(this.executionLogRepo, logId, {
        ...buildFinishPatch({
          outcome: 'error',
          errorMsg: errMsg,
          startedAtMs,
          runId,
          metrics: undefined,
          toolsAvailable,
          agentPromptHash,
        }),
        finishedAt: new Date().toISOString(),
        outcome: 'error',
        errorMsg: errMsg,
      })
      task = await manager.setAgentWorking(task, false)
      if (agentDef.exits?.[ERROR_EXIT]) {
        await manager.postError?.(task, errMsg)
      }
      task = await lifecycle.fail(task, agentDef, errMsg)
      throw err
    }

    return task
  }
}
