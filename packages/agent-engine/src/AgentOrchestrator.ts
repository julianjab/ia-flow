import { join } from 'path'
import type { Admission, AdmissionRequest, IAgentProvider } from '@ia-flow/ai-providers'
import { ADMIT, decline, withinDeclaredCap } from '@ia-flow/ai-providers'
import type { DispatchOutcome, ITaskSource } from '@ia-flow/issue-sources'
import type { ProviderLimit, Task } from '@ia-flow/shared'
import type { WorkspaceManager } from '@ia-flow/workspace'
import { Agent, type AgentRunState, type CompilePolicy } from './Agent.js'
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
      compilePolicyPort,
      linkedBranchNamer,
      resolveVariable,
    )
  }

  /**
   * Le pregunta al provider si toma la tarea. Sin `canAccept` propio queda el
   * default declarativo (`withinDeclaredCap`), que es lo que hace valer el
   * cap de la UI para todos los providers sin que ninguno escriba código.
   *
   * Dos fallos distintos, dos respuestas distintas:
   *
   * • **El id no está en el registry** → rechaza. Un provider ausente no es
   *   necesariamente un typo: los remotos se registran y desregistran solos
   *   según la salud de su agent-host (ver RemoteProviderHealthMonitor en
   *   apps/server), así que "no está" suele significar "todavía no está" —
   *   y diferir el issue hasta que vuelva es exactamente lo que hay que
   *   hacer. Admitir a ciegas mandaría el dispatch a un `Agent.run` que
   *   explota, disparando el `onError` del agente: mover el issue de status
   *   y comentar un fallo que no ocurrió.
   * • **Su `canAccept` lanza** → admite. Ahí el provider SÍ existe y el
   *   chequeo es el que está roto; un chequeo accidentado no debe congelar
   *   el pipeline, y si el run falla de verdad se reporta como corresponde.
   */
  private async admitProvider(providerId: string, req: AdmissionRequest): Promise<Admission> {
    let provider: IAgentProvider | undefined
    try {
      provider = this.providers.get(providerId)
    } catch {
      provider = undefined
    }
    // Ausente = no disponible, sin importar si el registry lo señala
    // lanzando o devolviendo `undefined`.
    if (!provider) {
      log.warn(
        { providerId, taskId: req.task.id },
        'Provider no registrado (¿agent-host caído o id inexistente?) — diferido',
      )
      return decline(`provider '${providerId}' no está disponible (no registrado)`)
    }
    try {
      if (!provider.canAccept) return withinDeclaredCap(req)
      return await provider.canAccept(req)
    } catch (err) {
      log.warn(
        { providerId, taskId: req.task.id, err: (err as Error).message },
        'canAccept falló — se asume disponible',
      )
      return ADMIT
    }
  }

  /**
   * `agentId` es el agente que la regla eligió, y es obligatorio: desde la
   * migración 059 el orquestador ya no decide quién corre.
   *
   * El fresh-read del status sigue pasando porque el resto del run lo
   * necesita —transiciones, guards— aunque ya no decida la selección.
   */
  async runAgent(task: Task, manager: ITaskSource, agentId: string): Promise<DispatchOutcome> {
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

    // Un `agentId` que no existe en el roster se saltea con un error ruidoso:
    // caer a otro agente sería correr algo que el operador no pidió, en
    // silencio, y ése es el modo de falla más caro de este sistema.
    const agent = (config.agents ?? []).find((a) => a.id === agentId)
    if (!agent) {
      log.error(
        { taskId: task.id, agentId, projectId: task.projectId },
        'La regla nombró un agente que no existe en este proyecto — dispatch salteado',
      )
      return 'skipped'
    }

    const runCtx = await resolveRunContext({
      task,
      agent,
      repoRepo: this.repoRepo,
      expandHome,
    })
    if (!runCtx) return 'skipped'
    let { primaryPath } = runCtx
    const { primaryRepoName, primaryTaskRepo } = runCtx

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
    // Un provider que rechaza no falla el dispatch: `resolveProvider` prueba
    // el siguiente candidato y sólo devuelve `saturated` cuando TODOS los
    // elegibles dijeron que no — ahí el item se difiere y se reintenta al
    // liberarse un slot, en vez de perderse hasta el próximo scan. El motivo
    // lo da el provider (ver IAgentProvider.canAccept), no lo deduce el
    // engine: la RAM del host o el trabajo que no vino de este daemon sólo
    // los conoce él.
    const resolution = await resolveProvider(
      agent.provider,
      task,
      this.classifyProvider,
      {
        limits: await this.providerLimits(),
        snapshot: this.pendingSnapshot,
        admit: (providerId, req) => this.admitProvider(providerId, req),
        // Snapshot del registry para expandir comodines (`remote:*`): la
        // oferta va a los que EXISTEN en este momento — un agent-host que se
        // registró hace un minuto ya recibe ofertas, uno caído no está.
        registeredIds: () => this.providers.list().map((p) => p.id),
      },
      agent.id,
    )
    if (resolution.kind === 'saturated') {
      log.info(
        { taskId: task.id, agent: agent.id, declined: resolution.declined },
        'Ningún provider candidato aceptó la tarea — diferido',
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

    // ── Task lock ─────────────────────────────────────────────────────
    // El lock por task es del ENGINE, no del provider: cubre todo el run
    // para que un segundo dispatch sobre la misma task falle rápido en
    // `acquireTask` en vez de correr una carrera sobre el mismo repo. Se
    // toma para cualquier provider — antes sólo se tomaba para
    // `anthropic-api`, con lo cual dos runs terminal sobre la misma task
    // podían pisarse el worktree. Sigue siendo condicional al manager
    // porque los tests arman el orquestador sin él.
    let workspaceLockHeld = false
    if (this.workspaceManager && primaryPath) {
      // May throw `task <id> ya está corriendo` — that's the intended
      // signal to the caller (e.g. a raced dispatcher), so propagate.
      this.workspaceManager.acquireTask(task, primaryPath)
      workspaceLockHeld = true
    }

    // Mutado por Agent.run: lleva la limpieza del terreno que preparó el
    // provider, para que el finally de abajo la corra sin importar por qué
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

      // El provider estaba al tope al arrancar el run (503 del agent-host entre
      // la sonda y el run — ver ProviderAtCapacityError). Nada se ejecutó y
      // `Agent.run` deliberadamente no corrió el `onError`: difiere, como si
      // lo hubiera rechazado la sonda.
      return runState.deferredAtCapacity ? 'deferred' : 'dispatched'
    } finally {
      // Release the per-task lock exactly once, no matter which exit path
      // (success return, agent throw, upstream abort) got us here.
      // `releaseTask` is idempotent so a duplicate call from a mis-wired
      // test wouldn't harm anything.
      if (workspaceLockHeld) {
        this.workspaceManager!.releaseTask(task.id)
      }

      // Limpieza del workspace: la decide y la arma el provider en su
      // `prepareWorkspace` (hoy sólo los terminal con workflow=worktree la
      // piden). Acá sólo se invoca — antes este bloque tenía cableado el
      // caso de tmux/iterm, incluyendo cómo derivar el path del worktree.
      // Best-effort: un fallo de limpieza no puede tapar el resultado del
      // run.
      if (runState.releaseWorkspace) {
        await runState.releaseWorkspace().catch((err: unknown) => {
          log.warn(
            { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
            'La limpieza del workspace falló — queda en disco',
          )
        })
      }
    }
  }
}
