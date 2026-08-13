import type { IBroadcast } from '../domain/ports/IBroadcast.js'
import type { IIssueManager, IssueItem } from '../domain/ports/IIssueManager.js'
import { issueItemToTask } from '../domain/ports/IIssueManager.js'
import type { IProjectConfigRepository } from '../domain/ports/IProjectConfigRepository.js'
import { createLogger } from '../logger.js'
import type { AgentOrchestrator } from './AgentOrchestrator.js'

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

    const statusLower = item.status.toLowerCase()
    const statusConfig = config.statuses?.find((s) => s.name.toLowerCase() === statusLower)
    if (!statusConfig) {
      log.debug(
        { id: item.id, projectId, status: item.status },
        'No agent configured for status — skipping',
      )
      return
    }

    // Blocker gate: unless the status explicitly opts into `allowBlocked`,
    // skip items whose source-native dependencies are still open. Sources
    // that don't model dependencies (or fail to fetch them) return empty.
    if (!statusConfig.allowBlocked && manager.getBlockers) {
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
