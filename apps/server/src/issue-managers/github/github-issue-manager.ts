import { getProjectConfig } from '../../config/project-config.js'
import {
  type ProjectItem,
  type ProjectMeta,
  clearItemWorking,
  getProjectMeta,
  listProjectItems,
} from '../../github/project.js'
import { createLogger } from '../../logger.js'
import { type Disposable, IssueManager } from '../issue-manager.js'
import type { TransitionManager } from '../transition-manager.js'
import type { BroadcastFn, IssueItem } from '../types.js'
import { GitHubTransitionManager } from './github-transition-manager.js'

const log = createLogger('github-issue-manager')

const POLL_INTERVAL_MS = 30_000

function projectItemToIssueItem(item: ProjectItem, projectId: string, owner: string): IssueItem {
  return {
    id: item.id,
    title: item.issueTitle,
    description: item.issueBody.split('\n\n---\n\n')[0].trim(),
    type: item.type.toLowerCase(),
    repos: item.repos
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
    status: item.status,
    agentWorking: item.working,
    meta: {
      issueId: item.issueId,
      issueNumber: item.issueNumber,
      issueUrl: `https://github.com/${owner}/${item.repoName}/issues/${item.issueNumber}`,
      repoName: item.repoName,
      issueBody: item.issueBody,
      projectId,
      owner,
    },
  }
}

export class GitHubIssueManager extends IssueManager {
  private meta: ProjectMeta | null = null

  constructor(
    private readonly projectUrl: string,
    private readonly broadcast: BroadcastFn,
  ) {
    super()
  }

  start(dispatch: (item: IssueItem) => Promise<void>): Disposable {
    const poll = async () => {
      try {
        if (!this.meta) {
          this.meta = await getProjectMeta(this.projectUrl)
          log.info(
            { projectId: this.meta.projectId, fields: Object.keys(this.meta.fields) },
            'Project loaded',
          )
          await this.resetWorkingItems()
        }

        const config = await getProjectConfig()
        const configuredStatuses = config?.statuses?.map((s) => s.name) ?? []

        for (const statusName of configuredStatuses) {
          const items = await listProjectItems(this.meta.projectId, this.meta.fields, statusName)
          for (const item of items) {
            if (item.working) continue // agent_working=true: already being processed (crash-safe skip)

            dispatch(projectItemToIssueItem(item, this.meta!.projectId, this.meta!.owner)).catch(
              (err) => log.error({ err, id: item.id }, 'Dispatch error'),
            )
          }
        }
      } catch (err) {
        log.error({ err }, 'Poll error — will retry next interval')
        this.meta = null
      }
    }

    poll().catch((err) => log.error({ err }, 'Initial poll failed'))
    const timer = setInterval(
      () => poll().catch((err) => log.error({ err }, 'Poll failed')),
      POLL_INTERVAL_MS,
    )
    return { dispose: () => clearInterval(timer) }
  }

  getTransitionManager(item: IssueItem): TransitionManager {
    const meta = this.meta!
    const issueId = item.meta?.issueId as string
    const repoName = item.meta?.repoName as string | undefined
    const issueNumber = item.meta?.issueNumber as number | undefined

    return new GitHubTransitionManager(
      meta,
      item.id,
      issueId,
      this.broadcast,
      repoName,
      issueNumber,
    )
  }

  // ─── Reset stuck Working=Yes items on startup (crash recovery) ──────────

  private async resetWorkingItems(): Promise<void> {
    const workingField = this.meta!.fields['Working']
    if (!workingField) return
    const items = await listProjectItems(this.meta!.projectId, this.meta!.fields)
    const stuck = items.filter((i) => i.working)
    if (!stuck.length) return
    log.info({ count: stuck.length }, 'Resetting stuck agent_working items on startup')
    await Promise.all(
      stuck.map((i) => clearItemWorking(this.meta!.projectId, i.id, workingField).catch(() => {})),
    )
  }
}
