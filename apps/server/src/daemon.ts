import { LocalIssueManager, issueItemToTask } from './issue-managers/local/local-issue-manager.js'
import { GitHubIssueManager } from './issue-managers/github/github-issue-manager.js'
import type { IssueItem, BroadcastFn } from './issue-managers/types.js'
import type { IssueManager } from './issue-managers/issue-manager.js'
import { runAgent } from './agents/agent-engine.js'
import { getProjectConfig } from './config/project-config.js'
import { createLogger } from './logger.js'

const log = createLogger('daemon')

let broadcast: BroadcastFn = () => {}

export function setBroadcast(fn: BroadcastFn) {
  broadcast = fn
}

async function dispatch(item: IssueItem, manager: IssueManager): Promise<void> {
  if (manager.validate) {
    const { ok, reason } = await manager.validate(item)
    if (!ok) {
      log.debug({ id: item.id, reason }, 'Item failed validation — skipping')
      return
    }
  }

  const config = await getProjectConfig()
  if (!config) {
    log.warn({ id: item.id }, 'No project config — skipping')
    return
  }

  const statusLower = item.status.toLowerCase()
  const hasAgent = config.statuses?.some((s) => s.name.toLowerCase() === statusLower) ?? false
  if (!hasAgent) {
    log.debug({ id: item.id, status: item.status }, 'No agent configured for status — skipping')
    return
  }

  const transitions = manager.getTransitionManager(item)
  const task = issueItemToTask(item)

  await runAgent(task, broadcast, transitions)
}

export function startDaemon(): void {
  const managers: IssueManager[] = [new LocalIssueManager()]

  const githubUrl = Bun.env.GITHUB_PROJECT_URL
  if (githubUrl) {
    managers.push(new GitHubIssueManager(githubUrl, broadcast))
  }

  for (const manager of managers) {
    manager.start((item) => dispatch(item, manager).catch((err) =>
      log.error({ err, id: item.id }, 'Unhandled dispatch error')
    ))
  }
}
