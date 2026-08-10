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

    const config = await this.configRepo.getConfig(projectId)
    if (!config) {
      log.warn({ id: item.id, projectId }, 'No project config — skipping')
      return
    }

    const statusLower = item.status.toLowerCase()
    const hasAgent = config.statuses?.some((s) => s.name.toLowerCase() === statusLower) ?? false
    if (!hasAgent) {
      log.debug(
        { id: item.id, projectId, status: item.status },
        'No agent configured for status — skipping',
      )
      return
    }

    const transitions = manager.getTransitionManager(item)
    const task = issueItemToTask(item)

    await this.orchestrator.runAgent(task, transitions)
  }
}
