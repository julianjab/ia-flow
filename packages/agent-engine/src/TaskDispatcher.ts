import type { DispatchOutcome, IIssueManager, IssueItem } from '@ia-flow/issue-sources'
import { issueItemToTask } from '@ia-flow/issue-sources'
import type { AgentOrchestrator } from './AgentOrchestrator.js'
import { type PendingSnapshot, atCap, countRunningByAgent } from './capacity.js'
import type { IBroadcast, IExecutionLogRepository, IProjectConfigRepository } from './contract.js'
import { issueRef } from './issue-ref.js'
import { createLogger } from './logger.js'

const log = createLogger('task-dispatcher')

// How long after a `cancelled` run to hold off redispatching the SAME task.
// The session-watchdog (session-watchdog.ts) can close a terminal run as
// `cancelled` on a false-positive liveness read while the real terminal
// session — and the agent inside it — keeps working. Without this cooldown
// the very next scan cycle sees the task still sitting in the same status
// (no `onFinish`/`onError` ran — cancellation explicitly skips the
// transition, see Agent.ts) and redispatches immediately, opening a SECOND
// terminal session on top of the still-live one. That's what produced the
// "No hay tarea activa" errors when the original session finally tried to
// call complete_task/update_issue_body — its PendingTask entry was gone.
const DEFAULT_CANCEL_COOLDOWN_MS = 2 * 60_000

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
    /** La regla que pidió este dispatch, cuando vino de una. Sólo viaja hasta
     *  la entrada del registry y hasta la fila de `execution_logs`: nada del
     *  engine decide con esto. */
    ruleId?: string,
    /** El evento que causó el dispatch. Misma naturaleza que `ruleId` —
     *  trazabilidad— y es lo que agrupa este run con las demás acciones que la
     *  regla corrió en el mismo disparo. */
    event?: { id: string; type: string; position?: number },
    /** Por qué corre el agente esta vez, ya rendido contra el evento por la
     *  acción `agent` de la regla. A diferencia de `ruleId` y `event`, esto
     *  NO es trazabilidad: se antepone al user turn y el modelo lo lee. */
    brief?: string,
  ): Promise<DispatchOutcome> {
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
    if (this.executionLogRepo) {
      const [lastRun] = this.executionLogRepo.list({ taskId: item.id, limit: 1 })
      if (lastRun?.outcome === 'cancelled' && lastRun.finishedAt) {
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

    return await this.orchestrator.runAgent(task, transitions, agentId, {
      ruleId,
      eventId: event?.id,
      eventType: event?.type,
      position: event?.position,
      brief,
    })
  }
}
