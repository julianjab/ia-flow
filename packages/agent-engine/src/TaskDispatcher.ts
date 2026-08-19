import type { IIssueManager, IssueItem } from '@ia-flow/issue-sources'
import { issueItemToTask } from '@ia-flow/issue-sources'
import type { AgentOrchestrator } from './AgentOrchestrator.js'
import { selectAgent, summarizeRejections } from './agent-selection.js'
import type { IBroadcast, IProjectConfigRepository } from './contract.js'
import { createLogger } from './logger.js'

const log = createLogger('task-dispatcher')

export class TaskDispatcher {
  constructor(
    private orchestrator: AgentOrchestrator,
    private broadcast: IBroadcast,
    private configRepo: IProjectConfigRepository,
  ) {}

  async dispatch(item: IssueItem, manager: IIssueManager): Promise<void> {
    if (manager.validate) {
      const { ok, reason } = await manager.validate(item)
      if (!ok) {
        log.debug({ id: item.id, reason }, 'Item failed validation — skipping')
        return
      }
    }

    // Every item carries its ia-flow projectId (stamped by the polling
    // manager). Without it we can't resolve which statuses/agents are wired,
    // so we can't dispatch — this used to silently fall through to the single
    // "default" config in the pre-multi-tenant era.
    const projectId = item.projectId
    if (!projectId) {
      log.warn({ id: item.id }, 'Item missing projectId — skipping (manager did not stamp it)')
      return
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
        return
      }
    }

    const config = await this.configRepo.getConfig(projectId)
    if (!config) {
      log.warn({ id: item.id, projectId }, 'No project config — skipping')
      return
    }

    // Gate on the same criteria that will actually pick the agent — no more
    // separate `config.statuses.find(...)` lookup: `selectAgent`/`matchesStatus`
    // already compares `agent.statusName` against `item.status` as a plain
    // string, so a status nobody wired to an agent is naturally rejected
    // here without needing a matching `StatusConfig` row to exist for it.
    // (SourceIssueManager's scan-cycle prefilter, one layer up, still reads
    // the real `statusRepo` to decide which statuses are worth fetching at
    // all — that one can't be derived from the agent roster the same way,
    // since an agent with no `statusName` matches every status and can't be
    // represented in a finite name list.) The orchestrator re-selects
    // against a freshly re-read status before running (see
    // AgentOrchestrator.runAgent) — this pre-check just decides whether to
    // bother dispatching at all, using the status we already have in hand.
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
      return
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
        return
      }
    }

    const transitions = manager.getTransitionManager(item)

    // Populate comments so `{{task.comments}}` renders in agent prompts. Poll
    // fetches don't include them (would be N+1 per cycle); load lazily now
    // that we've committed to dispatching this specific item.
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

    await this.orchestrator.runAgent(task, transitions)
  }
}
