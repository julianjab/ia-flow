import { join } from 'path'
import type { Admission, AdmissionRequest, IAgentProvider } from '@ia-flow/ai-providers'
import { ADMIT, decline, withinDeclaredCap } from '@ia-flow/ai-providers'
import type { DispatchOutcome, ITaskSource } from '@ia-flow/issue-sources'
import type { AgentExit, ProviderLimit, Task } from '@ia-flow/shared'
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
  PauseCheckpointPort,
  RunCheckpointPort,
  RunMessagePort,
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
    // Cola de mensajes inyectados en un run en curso. Ausente = el loop no
    // drena nada, que es el comportamiento previo a este canal.
    runMessages?: RunMessagePort,
    // Ver PauseCheckpointPort: el checkpoint no existe cuando la tool arma la
    // pausa, así que se cuelga después.
    pauseCheckpoint?: PauseCheckpointPort,
    // Persiste dónde va el run en cada vuelta, para que un reinicio no se
    // lleve el trabajo. El orquestador además lo BORRA en su `finally`: es el
    // único punto que corre una vez por run pase lo que pase.
    private runCheckpoints?: RunCheckpointPort,
  ) {
    this.agent = new Agent(
      providers,
      broadcast,
      mcpCatalogRepo,
      executionLogRepo,
      compilePolicyPort,
      linkedBranchNamer,
      resolveVariable,
      runMessages,
      pauseCheckpoint,
      runCheckpoints,
    )
  }

  /**
   * Cuántas veces se puede reanudar un run desde su checkpoint.
   *
   * Sin tope, un run que hace crashear al proceso (OOM, un loop de tools) se
   * reanuda al bootear, lo vuelve a matar, y el reinicio queda en bucle. Tres
   * intentos alcanzan para un fallo transitorio y cortan uno determinista.
   */
  private static readonly MAX_RESUME_ATTEMPTS = 3

  /**
   * Hasta cuándo un checkpoint sigue representando "dónde iba" la task.
   *
   * Nadie lo borra cuando la task deja de pasar por el pipeline: si alguien
   * movió el issue a Done y meses después vuelve, `getByTask` ofrecería una
   * conversación vieja como si fuera trabajo en curso. Un run real no dura un
   * día; una fila olvidada, sí. Mismo criterio (y mismo número) que el techo
   * de las filas huérfanas de `execution_logs`.
   */
  private static readonly MAX_RESUME_AGE_MS = 24 * 60 * 60_000

  /**
   * El checkpoint del que este dispatch debería retomar, si hay alguno.
   *
   * Tres gates, y los tres descartan en silencio hacia "arrancar de cero" —
   * que siempre es correcto, sólo más caro:
   *
   *  - **Otro agente.** El checkpoint lleva la conversación de QUIEN lo
   *    escribió; dársela a otro agente sería darle un contexto que no es suyo
   *    y un prompt que nunca vio. La fila se borra: ese run ya no va a volver.
   *  - **Demasiado viejo.** Ver MAX_RESUME_AGE_MS.
   *  - **Demasiados intentos.** Ver MAX_RESUME_ATTEMPTS.
   *  - **Un sub-agente.** Corre sobre la misma task que su padre, así que
   *    `getByTask` le devolvería el checkpoint del PADRE — el mismo choque de
   *    clave que resolvió `<taskId>#sub:<runId>` en el registry de pendientes.
   */
  private async loadResume(
    task: Task,
    agentId: string,
    isSub: boolean,
  ): Promise<{ messages: unknown[]; attempts: number } | undefined> {
    if (!this.runCheckpoints || isSub) return undefined

    const cp = await this.runCheckpoints.getByTask(task.id).catch((err: unknown) => {
      // Leer el checkpoint es una optimización, no un requisito: si el store
      // falla, el run arranca de cero en vez de no arrancar.
      log.warn({ taskId: task.id, err }, 'No se pudo leer el checkpoint — se arranca de cero')
      return null
    })
    if (!cp) return undefined

    if (cp.agentId && cp.agentId !== agentId) {
      log.info(
        { taskId: task.id, checkpointAgent: cp.agentId, agentId },
        'El checkpoint es de otro agente — se descarta y se arranca de cero',
      )
      await this.runCheckpoints.delete(cp.runId).catch(() => {})
      return undefined
    }

    const ageMs = Date.now() - Date.parse(cp.updatedAt)
    if (Number.isFinite(ageMs) && ageMs > AgentOrchestrator.MAX_RESUME_AGE_MS) {
      log.info(
        { taskId: task.id, agentId, ageHours: Math.round(ageMs / 3_600_000) },
        'El checkpoint es demasiado viejo para representar trabajo en curso — se descarta',
      )
      await this.runCheckpoints.delete(cp.runId).catch(() => {})
      return undefined
    }

    if (cp.attempts >= AgentOrchestrator.MAX_RESUME_ATTEMPTS) {
      log.error(
        { taskId: task.id, agentId, attempts: cp.attempts },
        'El checkpoint ya se reanudó demasiadas veces — se descarta',
      )
      await this.runCheckpoints.delete(cp.runId).catch(() => {})
      return undefined
    }

    const state = cp.state as { messages?: unknown[] } | null
    if (!state?.messages?.length) return undefined

    // La fila vieja se borra ACÁ y no al terminar: el run nuevo guarda bajo su
    // propio `runId`, así que sin esto la del run muerto le sobreviviría y
    // `getByTask` la volvería a ofrecer — reanimando para siempre un
    // checkpoint ya consumido.
    await this.runCheckpoints.delete(cp.runId).catch((err: unknown) => {
      log.warn({ taskId: task.id, runId: cp.runId, err }, 'No se pudo borrar el checkpoint viejo')
    })

    log.info(
      { taskId: task.id, agentId, from: cp.runId, attempts: cp.attempts + 1 },
      'Reanudando desde el checkpoint del run anterior',
    )
    return { messages: state.messages, attempts: cp.attempts + 1 }
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
  private static readonly MAX_AGENT_DEPTH = 3

  /**
   * Corre un agente como HIJO de otro run, y devuelve lo que produjo.
   *
   * Es la contracara de `runAgent`: aquél reporta un `DispatchOutcome` porque
   * su consumidor es el dispatcher, que sólo necesita saber si el item se
   * soltó o vuelve al backlog. Acá el consumidor es el agente padre, que
   * espera un texto para seguir razonando.
   *
   * Un hijo que no corre NO es un fallo del padre: el motivo vuelve como
   * `{ ok: false }` para que el padre decida (reintentar con otro agente,
   * seguir sin él), en vez de tirar y llevarse puesto un run que iba bien.
   */
  async runSubAgent(input: {
    task: Task
    manager: ITaskSource
    agentId: string
    parentRunId: string
    parentDepth: number
  }): Promise<{ ok: true; output: string } | { ok: false; reason: string }> {
    const state: AgentRunState = {}
    const outcome = await this.runAgent(
      input.task,
      input.manager,
      input.agentId,
      { parentRunId: input.parentRunId, agentDepth: input.parentDepth + 1 },
      state,
    )
    if (outcome !== 'dispatched') {
      return {
        ok: false,
        reason:
          outcome === 'deferred'
            ? 'no hay capacidad ahora mismo (cap del agente o del provider)'
            : 'no se pudo despachar — revisá que el id exista en el roster y que la cadena de delegación no sea demasiado profunda',
      }
    }
    // Un run que terminó sin texto es raro pero no es un error: el padre
    // necesita algo que leer, y un string vacío como `tool_result` es peor
    // que decirle que no hubo salida.
    return { ok: true, output: state.output?.trim() || '(el agente terminó sin producir texto)' }
  }

  async runAgent(
    task: Task,
    manager: ITaskSource,
    agentId: string,
    /**
     * De dónde viene este dispatch. Todo opcional: un caller que no sepa nada
     * de reglas ni de delegación (un test, un dispatch manual) puede omitirlo.
     *
     * `ruleId` es sólo trazabilidad — queda en la entrada del registry para
     * que la UI pueda dibujar el run sobre la regla que lo lanzó.
     *
     * `parentRunId` SÍ cambia el comportamiento: el run no vuelve a tomar el
     * lock de la task (lo tiene el padre, y pedirlo otra vez lo bloquearía
     * contra sí mismo) y no cuenta contra el cap de dispatch del proyecto.
     */
    origin?: {
      ruleId?: string
      eventId?: string
      eventType?: string
      /** Índice de la acción `agent` dentro del `do[]` de la regla. Es lo que
       *  ordena este run entre las demás filas de su mismo disparo. */
      position?: number
      parentRunId?: string
      agentDepth?: number
      /** Por qué corre el agente esta vez. El único campo de `origin` que el
       *  MODELO ve: los demás son trazabilidad. */
      brief?: string
      /** Redirecciones de salida declaradas por la regla. */
      exits?: Record<string, AgentExit>
    },
    /** Provisto por `runSubAgent` para poder leer la salida del run. Un
     *  dispatch normal no lo pasa y el orquestador arma el suyo. */
    outerState?: AgentRunState,
  ): Promise<DispatchOutcome> {
    // Scope the config lookup to the task's project when known — matches how
    // TaskDispatcher fetched it. Legacy callers without projectId fall back to
    // the default project (SqliteProjectConfigRepo.getConfig undefined path).
    // El freno de la cadena de delegación. `EngineEvent.depth` cubre el camino
    // por eventos; la tool no pasa por el bus, así que necesita el suyo — sin
    // esto un agente que se delega a sí mismo (directo, o A→B→A) es un loop
    // sin fondo que consume presupuesto hasta que alguien lo mate a mano.
    //
    // `skipped` y no `deferred`: la profundidad no se despeja esperando.
    const isSub = origin?.parentRunId != null
    if (isSub && (origin?.agentDepth ?? 0) > AgentOrchestrator.MAX_AGENT_DEPTH) {
      log.error(
        {
          taskId: task.id,
          agentId,
          depth: origin?.agentDepth,
          max: AgentOrchestrator.MAX_AGENT_DEPTH,
          parentRunId: origin?.parentRunId,
        },
        'Cadena de sub-agentes demasiado profunda — posible delegación circular',
      )
      return 'skipped'
    }

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
    // Un sub-agente NO vuelve a tomarlo: su padre ya lo tiene, y sobre la
    // misma task `acquireTask` lo bloquearía contra sí mismo. Es re-entrante
    // por delegación, no por task — dos dispatches independientes sobre la
    // misma task siguen chocando, que es lo que el lock existe para evitar.
    let workspaceLockHeld = false
    if (!isSub && this.workspaceManager && primaryPath) {
      // May throw `task <id> ya está corriendo` — that's the intended
      // signal to the caller (e.g. a raced dispatcher), so propagate.
      this.workspaceManager.acquireTask(task, primaryPath)
      workspaceLockHeld = true
    }

    // Mutado por Agent.run: lleva la limpieza del terreno que preparó el
    // provider, para que el finally de abajo la corra sin importar por qué
    // salida terminó el run.
    const runState: AgentRunState = outerState ?? {}

    // ¿Quedó trabajo a medio hacer de un run anterior de esta task? Una fila
    // viva significa que el run que la escribió NO cerró: se pausó, o el
    // proceso murió antes del `finally` que la borra.
    const resumeCheckpoint = await this.loadResume(task, agent.id, isSub)

    try {
      task = await this.agent.run(
        {
          task,
          agentDef: agent,
          resolvedProviderId,
          manager,
          config,
          resumeCheckpoint,
          runCtx: { ...runCtx, primaryPath },
          ruleId: origin?.ruleId,
          eventId: origin?.eventId,
          eventType: origin?.eventType,
          position: origin?.position,
          parentRunId: origin?.parentRunId,
          agentDepth: origin?.agentDepth,
          brief: origin?.brief,
          exitOverrides: origin?.exits,
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

      // El checkpoint es estado de trabajo de un run VIVO: cuando el run
      // terminó —bien, mal o pausado— ya no queda nadie que lo continúe con
      // ese id. Una pausa no lo pierde: `attachCheckpoint` ya lo copió a su
      // espera, que es lo que sobrevive al run.
      //
      // Sin este borrado la conversación entera de cada run quedaría en disco
      // para siempre.
      if (runState.runId && this.runCheckpoints) {
        await this.runCheckpoints.delete(runState.runId).catch((err: unknown) => {
          log.warn(
            { taskId: task.id, runId: runState.runId, err },
            'No se pudo borrar el checkpoint del run',
          )
        })
      }
    }
  }
}
