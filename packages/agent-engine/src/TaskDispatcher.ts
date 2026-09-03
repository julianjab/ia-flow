import type { DispatchOutcome, IIssueManager, IssueItem } from '@ia-flow/issue-sources'
import { issueItemToTask } from '@ia-flow/issue-sources'
import type { AgentExit } from '@ia-flow/shared'
import { TaskLockedError } from '@ia-flow/workspace'
import type { AgentRunState } from './Agent.js'
import type { AgentOrchestrator } from './AgentOrchestrator.js'
import { type PendingSnapshot, atCap, countRunningByAgent } from './capacity.js'
import type {
  IBroadcast,
  IExecutionLogRepository,
  IProjectConfigRepository,
  RunMessageEnqueuePort,
} from './contract.js'
import { issueRef } from './issue-ref.js'
import { createLogger } from './logger.js'

const log = createLogger('task-dispatcher')

// How long after a `cancelled` TERMINAL run to hold off redispatching the
// SAME task. The session-watchdog (session-watchdog.ts) can close a tmux/
// iterm run as `cancelled` on a false-positive liveness read while the real
// terminal session — and the agent inside it — keeps working. Without this
// cooldown the very next scan cycle sees the task still sitting in the same
// status (no `onFinish`/`onError` ran — cancellation explicitly skips the
// transition, see Agent.ts) and redispatches immediately, opening a SECOND
// terminal session on top of the still-live one. That's what produced the
// "No hay tarea activa" errors when the original session finally tried to
// call complete_task/update_issue_body — its PendingTask entry was gone.
//
// Sólo aplica a runs con `sessionKind` seteado (Agent.ts lo escribe SOLO
// cuando `output.mode === 'tmux'`, o sea un SessionHandle real de un
// provider terminal). Un run sync (`anthropic-api`) no deja ningún proceso
// vivo del otro lado — corre y termina dentro del mismo `await` — así que
// sus tres caminos reales a `cancelled` (provider-at-capacity: nunca
// arrancó; status-divergence: cancelación intencional del engine;
// upstream-abort: se cortó el stream) no tienen la ventana de "sesión
// zombie" que este cooldown existe para evitar. Aplicárselo igual sólo le
// suma hasta 2 minutos de latencia sin ganar nada — diagnosticado contra
// lh-seller-v2-frontend#3854, un retry legítimo de un agente sync diferido
// sin motivo.
const DEFAULT_CANCEL_COOLDOWN_MS = 2 * 60_000

// El único provider que drena `RunMessagePort` EN VIVO —
// `packages/ai-providers/src/anthropic-api/provider.ts` es el único que
// cablea `drainMessages: input.drainMessages` en su loop de tools. Un run
// remoto (`remote:*`, mismo `AnthropicApiProvider` pero del otro lado de un
// agent-host) no recibe ese campo en el `ProviderInput` que cruza el cable
// (ver CLAUDE.md, "Qué viaja a un provider remoto"), y un run de terminal
// (tmux/iterm) tampoco lo consulta. Fuera de este único caso, un mensaje
// encolado se queda ahí hasta que algo más lo drene — puede no pasar nunca.
const LIVE_DRAIN_PROVIDER_ID = 'anthropic-api'

/**
 * Todo lo que un dispatch puede traer además del qué y el quién.
 *
 * Un objeto y no parámetros de cola: llegaron a ser cinco, y con posicionales
 * agregar el sexto obliga a pasar `undefined` por los cuatro del medio. Ningún
 * caller del daemon usa ninguno — los pone la acción `agent` de una regla.
 */
export interface DispatchOptions {
  /** La regla que pidió este dispatch. Sólo viaja hasta la entrada del
   *  registry y hasta la fila de `execution_logs`: nada del engine decide con
   *  esto. */
  ruleId?: string
  /** El evento que causó el dispatch. Misma naturaleza que `ruleId`
   *  —trazabilidad— y es lo que agrupa este run con las demás acciones que la
   *  regla corrió en el mismo disparo. */
  event?: { id: string; type: string; position?: number }
  /** Por qué corre el agente esta vez, ya rendido contra el evento. A
   *  diferencia de `ruleId` y `event`, esto NO es trazabilidad: se antepone al
   *  user turn y el modelo lo lee. */
  brief?: string
  /** Redirecciones de salida declaradas por la regla. El agente sigue siendo
   *  dueño de QUÉ salidas existen; esto sólo cambia a dónde van. */
  exits?: Record<string, AgentExit>
  /** Estado compartido del run. Es por donde VUELVE lo que el agente produjo
   *  (`output` / `structuredOutput`), que es lo que una regla publica como
   *  `{{steps.<paso>.output}}`. Mismo mecanismo que usa `runSubAgent` para
   *  leer el resultado de un hijo. */
  state?: AgentRunState
  /** Ver `AgentActionSchema.liveInject` en `@ia-flow/shared`. Relaja el gate
   *  de entrega en vivo del catch de abajo: no exige que el run activo sea
   *  del MISMO agente que este dispatch, sólo que esté vivo y sobre el
   *  provider que drena `RunMessagePort` en vivo. */
  liveInject?: boolean
}

export class TaskDispatcher {
  constructor(
    private orchestrator: AgentOrchestrator,
    private broadcast: IBroadcast,
    private configRepo: IProjectConfigRepository,
    // Snapshot de runs en vuelo para el cap por agente. Default: el registry
    // compartido (ver capacity.ts) — inyectable sólo para tests.
    private pendingSnapshot?: PendingSnapshot,
    // Opcional: sin él, el dispatcher no tiene forma de ver `cancelled`
    // recientes y el cooldown de abajo queda deshabilitado (comportamiento
    // previo).
    private executionLogRepo?: IExecutionLogRepository,
    // Opcional: sin él, un dispatch que choca contra el lock de la task
    // (`TaskLockedError`) sólo difiere — ver el catch en `dispatch()` más
    // abajo para el porqué de encolar en vez de perder el `brief`.
    private runMessageEnqueuer?: RunMessageEnqueuePort,
    private cancelCooldownMs: number = DEFAULT_CANCEL_COOLDOWN_MS,
  ) {}

  /**
   * `agentId` es el agente que la regla eligió, y es obligatorio: desde la
   * migración 059 el dispatcher ya no selecciona.
   *
   * El resto de los gates —health, capacidad, cooldown, blockers— siguen
   * aplicando igual: son sobre el mundo, no sobre quién corre.
   */
  async dispatch(
    item: IssueItem,
    manager: IIssueManager,
    agentId: string,
    opts: DispatchOptions = {},
  ): Promise<DispatchOutcome> {
    const { ruleId, event, brief, exits, liveInject } = opts
    if (manager.validate) {
      const { ok, reason } = await manager.validate(item)
      if (!ok) {
        log.debug(
          { id: item.id, issue: issueRef(item), reason },
          `Item ${issueRef(item)} failed validation — skipping`,
        )
        return 'skipped'
      }
    }

    // Every item carries its ia-flow projectId (stamped by the polling
    // manager). Without it we can't resolve which statuses/agents are wired,
    // so we can't dispatch — this used to silently fall through to the single
    // "default" config in the pre-multi-tenant era.
    const projectId = item.projectId
    if (!projectId) {
      log.warn(
        { id: item.id, issue: issueRef(item) },
        `Item ${issueRef(item)} missing projectId — skipping (manager did not stamp it)`,
      )
      return 'skipped'
    }

    // Safety net: even though PollingIssueManager already gates on getHealth,
    // dispatch could be reached through an in-memory item that pre-dated a
    // health degradation (URL edited to something invalid mid-cycle, token
    // expired, …). Bail before we run an agent against a broken source.
    if (manager.getHealth) {
      const health = await manager.getHealth().catch(() => null)
      if (health && !health.ok) {
        log.warn(
          {
            id: item.id,
            issue: issueRef(item),
            projectId,
            missing: health.missing.map((f) => f.name),
            message: health.message,
          },
          `Source unhealthy — skipping dispatch of ${issueRef(item)}`,
        )
        return 'skipped'
      }
    }

    const config = await this.configRepo.getConfig(projectId)
    if (!config) {
      log.warn(
        { id: item.id, issue: issueRef(item), projectId },
        `No project config — skipping ${issueRef(item)}`,
      )
      return 'skipped'
    }

    // Gate on the same criteria that will actually pick the agent — no more
    // separate `config.statuses.find(...)` lookup: `selectAgent`/`matchesStatus`
    // already compares `agent.statusName` against `item.status` as a plain
    // string, so a status nobody wired to an agent is naturally rejected
    // here without needing a matching `StatusConfig` row to exist for it.
    // `selectAgent` is now the ONLY gate on the dispatch path — SourceIssueManager
    // no longer prefilters by status before calling this (see
    // source-issue-manager.ts's class doc): it fetches once and hands every
    // item to `dispatch`. For an agent with a `statusName` this is a cheap
    // reject (getHealth + getConfig, before getBlockers/loadComments/
    // runAgent). For an agent with NO `statusName` there is deliberately no
    // cap here either — it's a candidate for every item the source returns,
    // by design (see agent-selection.ts's matchesStatus); scoping it is the
    // operator's job via `when`/`statusName`, not this gate's. The
    // orchestrator re-selects against a freshly re-read status before
    // running (see AgentOrchestrator.runAgent) — this pre-check just decides
    // whether to bother dispatching at all, using the status we already
    // have in hand.
    // Built without comments (loaded lazily below, only once we've committed
    // to dispatching) — fine for this gate, `selectAgent`'s filters never
    // look at `task.comments`.
    const agent = (config.agents ?? []).find((a) => a.id === agentId)
    if (!agent) {
      log.error(
        { id: item.id, issue: issueRef(item), projectId, agentId },
        `La regla nombró un agente que no existe en este proyecto (${agentId}) — skipping`,
      )
      return 'skipped'
    }

    // Cap por agente — pre-check barato, antes de gastar getBlockers y
    // loadComments (que son llamadas a la fuente, N+1 por item). Es el mismo
    // patrón que el gate de `selectAgent` de arriba: acá se decide si vale la
    // pena seguir, y el chequeo autoritativo lo hace el orquestador contra el
    // agente que realmente va a correr (puede re-seleccionar otro tras el
    // fresh-read del status). Diferido, no skipeado: hay trabajo, falta lugar.
    const agentRunning = countRunningByAgent(agent.id, this.pendingSnapshot)
    if (atCap(agentRunning, agent.maxConcurrentDispatches)) {
      log.info(
        {
          id: item.id,
          issue: issueRef(item),
          projectId,
          agent: agent.id,
          running: agentRunning,
          cap: agent.maxConcurrentDispatches,
        },
        `Agente '${agent.id}' al tope de runs simultáneos — ${issueRef(item)} diferido`,
      )
      return 'deferred'
    }

    // Cooldown post-cancelación — ver el comment del campo arriba. Chequea
    // sólo la fila más reciente de ESTE task (barato: índice por task_id, un
    // SELECT local a SQLite) antes de comprometerse a un dispatch real.
    //
    // `lastRun.sessionKind` es la señal de runtime de si ESE run en
    // particular tuvo un SessionHandle terminal real (Agent.ts sólo lo
    // escribe dentro de `output.mode === 'tmux'`) — más confiable que mirar
    // `agent.provider` acá: cubre también `remote:*`, cuyo kind resuelto
    // varía por dispatch y no se puede saber desde la config del agente.
    if (this.executionLogRepo) {
      const [lastRun] = this.executionLogRepo.list({ taskId: item.id, limit: 1 })
      if (lastRun?.outcome === 'cancelled' && lastRun.finishedAt && lastRun.sessionKind) {
        const elapsedMs = Date.now() - new Date(lastRun.finishedAt).getTime()
        if (elapsedMs >= 0 && elapsedMs < this.cancelCooldownMs) {
          log.warn(
            {
              id: item.id,
              issue: issueRef(item),
              projectId,
              agent: agent.id,
              lastRunId: lastRun.id,
              elapsedMs,
              cooldownMs: this.cancelCooldownMs,
            },
            `Run anterior de ${issueRef(item)} cancelado hace poco (posible falso positivo del session-watchdog) — difiero en vez de abrir una segunda sesión en paralelo`,
          )
          return 'deferred'
        }
      }
    }

    // Blocker gate: unless the matched agent explicitly opts into
    // `allowBlocked`, skip items whose source-native dependencies are still
    // open. Sources that don't model dependencies (or fail to fetch them)
    // return empty.
    if (!agent.allowBlocked && manager.getBlockers) {
      const blockers = await manager.getBlockers(item).catch((err) => {
        log.warn(
          { id: item.id, issue: issueRef(item), projectId, err: (err as Error).message },
          `getBlockers threw for ${issueRef(item)} — dispatching anyway`,
        )
        return [] as Array<{ id: string; ref?: string }>
      })
      if (blockers.length) {
        log.info(
          {
            id: item.id,
            issue: issueRef(item),
            projectId,
            status: item.status,
            blockers: blockers.map((b) => b.ref ?? b.id),
          },
          `Item ${issueRef(item)} skipped — blocked by unfinished issues`,
        )
        return 'skipped'
      }
    }

    const transitions = manager.getTransitionManager(item)
    // Forward the IIssueManager-level mark-as-read primitive onto the
    // per-item TaskSource so Agent.run can call it AFTER the provider has
    // actually consumed the prompt, using the FINAL agentDef (Agent.run's
    // caller re-selects against a freshly-read status — see
    // AgentOrchestrator.runAgent — so `agent` here isn't guaranteed to be
    // the one that ends up running). `getTransitionManager` returns a fresh
    // instance per call, so mutating it here is safe.
    if (manager.markCommentsUsed) {
      transitions.markCommentsUsed = (comments) => manager.markCommentsUsed!(comments)
    }

    // Populate comments so `{{task.comments}}` renders in agent prompts. Poll
    // fetches don't include them (would be N+1 per cycle); load lazily now
    // that we've committed to dispatching this specific item. Marking them
    // as read happens later, inside Agent.run — NOT here — so a crash
    // between this load and the provider actually running (lock contention,
    // worktree setup, provider connection failure) doesn't burn a human
    // comment nobody ever saw.
    if (manager.loadComments && !item.comments?.length) {
      try {
        item.comments = await manager.loadComments(item)
      } catch (err) {
        log.warn(
          { id: item.id, err: (err as Error).message },
          'loadComments threw — dispatching without comments',
        )
      }
    }

    const task = issueItemToTask(item)

    try {
      return await this.orchestrator.runAgent(
        task,
        transitions,
        agentId,
        {
          ruleId,
          eventId: event?.id,
          eventType: event?.type,
          position: event?.position,
          brief,
          exits,
        },
        opts.state,
      )
    } catch (err) {
      // El lock por task (`WorkspaceManager.acquireTask`) tira cuando ya hay
      // un run vivo sobre esta misma task — típicamente un dispatcher
      // raceado (una regla de comentario que llega mientras el agente sigue
      // corriendo la vuelta anterior). Antes esto se propagaba como
      // excepción sin manejar hasta el runner de reglas, que sólo lo
      // logueaba (`Rule action failed`) y perdía el `brief` para siempre —
      // el humano que comentó nunca veía su feedback llegar al agente en
      // vuelo.
      if (err instanceof TaskLockedError) {
        let delivered = false
        // La cola es POR TASK, no por agente ni por run (`RunMessagePort.
        // pending(taskId)` no filtra por quién la va a leer) — así que
        // encolar a ciegas puede entregarle el brief de un dispatch al run
        // EQUIVOCADO: si el lock lo tiene el agente B (o A, pero en un
        // provider que no drena en vivo), B se come instrucciones dirigidas
        // a A, y el dispatch de A queda `skipped` creyendo que se entregó
        // cuando en realidad se perdió. Por default sólo se puede afirmar la
        // entrega cuando la fila más reciente de ESTA task (mismo criterio
        // que usa el cooldown de cancelación, arriba) es del MISMO agente que
        // pidió este dispatch y sigue en vuelo (`finishedAt` null) sobre el
        // único provider que drena `RunMessagePort` en vivo.
        //
        // `liveInject: true` (la regla lo declara en la acción `agent`, ver
        // `AgentActionSchema`) releja ESE último chequeo: no exige que sea el
        // MISMO agente, sólo que el run activo esté vivo sobre ese provider.
        // Es el caso de un triage que choca con el lock antes de poder
        // siquiera decidir a quién despachar — sin la relajación, el brief
        // nunca se entrega porque el agente que chocó (el triage) nunca va a
        // ser el mismo que el run activo.
        if (brief && this.runMessageEnqueuer && this.executionLogRepo) {
          const [activeRun] = this.executionLogRepo.list({ taskId: item.id, limit: 1 })
          const canDeliverLive =
            activeRun != null &&
            activeRun.finishedAt == null &&
            activeRun.providerId === LIVE_DRAIN_PROVIDER_ID &&
            (activeRun.agentId === agentId || liveInject === true)
          if (canDeliverLive) {
            delivered = await this.runMessageEnqueuer
              .enqueue({ taskId: item.id, body: brief, source: 'rule-dispatch' })
              .then(() => true)
              .catch((enqueueErr) => {
                log.warn(
                  { id: item.id, issue: issueRef(item), err: (enqueueErr as Error).message },
                  `No se pudo encolar el brief tras chocar con el lock de ${issueRef(item)} — se pierde este intento`,
                )
                return false
              })
          }
        }
        // `skipped`, NO `deferred`, cuando el encolado funcionó: `deferred`
        // es la señal de "reintentá" (vuelve al backlog de `SourceDispatcher`
        // y un item de scan lo republica en el próximo ciclo), y reintentar
        // acá volvería a encolar el MISMO brief cada vez — duplicados
        // acumulándose en la cola mientras el run en vuelo no termina, más
        // uno de más si el reintento eventualmente entra (brief del run
        // nuevo + el que ya quedó encolado). Una vez entregado no hay nada
        // más que este dispatch pueda aportar: el run vivo lo va a drenar
        // (`RunMessagePort` en `Agent.ts`) solo, sin que nadie reintente.
        // Sin `brief` o sin poder entregarlo, en cambio, no se perdió nada
        // reintentable — ahí sí vale `deferred`.
        log.info(
          { id: item.id, issue: issueRef(item), agentId, delivered },
          `${issueRef(item)} ya tiene un run en vuelo — ${delivered ? 'brief encolado' : 'dispatch diferido'}`,
        )
        return delivered ? 'skipped' : 'deferred'
      }
      throw err
    }
  }
}
