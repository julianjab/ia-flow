import type { DispatchOutcome, IIssueManager, IssueItem } from '@ia-flow/issue-sources'
import { issueItemToTask } from '@ia-flow/issue-sources'
import type { AgentOrchestrator } from './AgentOrchestrator.js'
import { selectAgent, summarizeRejections } from './agent-selection.js'
import { type PendingSnapshot, atCap, countRunningByAgent } from './capacity.js'
import type { IBroadcast, IProjectConfigRepository } from './contract.js'
import { createLogger } from './logger.js'

const log = createLogger('task-dispatcher')

export class TaskDispatcher {
  constructor(
    private orchestrator: AgentOrchestrator,
    private broadcast: IBroadcast,
    private configRepo: IProjectConfigRepository,
    // Snapshot de runs en vuelo para el cap por agente. Default: el registry
    // compartido (ver capacity.ts) — inyectable sólo para tests.
    private pendingSnapshot?: PendingSnapshot,
  ) {}

  async dispatch(item: IssueItem, manager: IIssueManager): Promise<DispatchOutcome> {
    if (manager.validate) {
      const { ok, reason } = await manager.validate(item)
      if (!ok) {
        log.debug({ id: item.id, reason }, 'Item failed validation — skipping')
        return 'skipped'
      }
    }

    // Every item carries its ia-flow projectId (stamped by the polling
    // manager). Without it we can't resolve which statuses/agents are wired,
    // so we can't dispatch — this used to silently fall through to the single
    // "default" config in the pre-multi-tenant era.
    const projectId = item.projectId
    if (!projectId) {
      log.warn({ id: item.id }, 'Item missing projectId — skipping (manager did not stamp it)')
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
            projectId,
            missing: health.missing.map((f) => f.name),
            message: health.message,
          },
          'Source unhealthy — skipping dispatch',
        )
        return 'skipped'
      }
    }

    const config = await this.configRepo.getConfig(projectId)
    if (!config) {
      log.warn({ id: item.id, projectId }, 'No project config — skipping')
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
    const taskForGate = issueItemToTask(item)
    const { agent, rejected } = selectAgent({
      task: taskForGate,
      agents: config.agents ?? [],
      status: item.status,
    })
    if (!agent) {
      log.debug(
        { id: item.id, projectId, status: item.status, rejected: summarizeRejections(rejected) },
        'No agent matched — skipping',
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
          projectId,
          agent: agent.id,
          running: agentRunning,
          cap: agent.maxConcurrentDispatches,
        },
        'Agente al tope de runs simultáneos — diferido',
      )
      return 'deferred'
    }

    // Blocker gate: unless the matched agent explicitly opts into
    // `allowBlocked`, skip items whose source-native dependencies are still
    // open. Sources that don't model dependencies (or fail to fetch them)
    // return empty.
    if (!agent.allowBlocked && manager.getBlockers) {
      const blockers = await manager.getBlockers(item).catch((err) => {
        log.warn(
          { id: item.id, projectId, err: (err as Error).message },
          'getBlockers threw — dispatching anyway',
        )
        return [] as Array<{ id: string; ref?: string }>
      })
      if (blockers.length) {
        log.info(
          {
            id: item.id,
            projectId,
            status: item.status,
            blockers: blockers.map((b) => b.ref ?? b.id),
          },
          'Item skipped — blocked by unfinished issues',
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

    return await this.orchestrator.runAgent(task, transitions)
  }
}
