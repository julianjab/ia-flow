import { IssueManager, type Disposable } from '../issue-manager.js'
import type { IssueItem, ValidationResult, BroadcastFn } from '../types.js'
import type { TransitionManager } from '../transition-manager.js'
import { GitHubTransitionManager } from './github-transition-manager.js'
import {
  getProjectMeta,
  listProjectItems,
  updateItemStatus,
  addIssueComment,
  clearItemWorking,
  upsertValidationComment,
  clearValidationComment,
  getBlockingIssues,
  type ProjectMeta,
  type ProjectItem,
} from '../../github/project.js'
import { resolveGithubRepo } from '../../repos.js'
import { getProjectConfig } from '../../config/project-config.js'
import { createLogger } from '../../logger.js'

const log = createLogger('github-issue-manager')

const POLL_INTERVAL_MS = 30_000

function projectItemToIssueItem(item: ProjectItem, projectId: string, owner: string): IssueItem {
  return {
    id: item.id,
    title: item.issueTitle,
    description: item.issueBody.split('\n\n---\n\n')[0].trim(),
    type: item.type.toLowerCase(),
    repos: item.repos.split(',').map((r) => r.trim()).filter(Boolean),
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
          log.info({ projectId: this.meta.projectId, fields: Object.keys(this.meta.fields) }, 'Project loaded')
          await this.resetWorkingItems()
        }

        const config = await getProjectConfig()
        const configuredStatuses = config?.statuses?.map((s) => s.name) ?? []

        for (const statusName of configuredStatuses) {
          const items = await listProjectItems(this.meta.projectId, this.meta.fields, statusName)
          for (const item of items) {
            if (item.working) continue  // agent_working=true: already being processed (crash-safe skip)

            dispatch(projectItemToIssueItem(item, this.meta!.projectId, this.meta!.owner)).catch((err) =>
              log.error({ err, id: item.id }, 'Dispatch error')
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

  async validate(item: IssueItem): Promise<ValidationResult> {
    const issueId = item.meta?.issueId as string | undefined

    // Backlog items are new — the backlog-tagger will set repos/type, skip validation
    if (item.status.toLowerCase() === 'backlog') {
      if (issueId) await clearValidationComment(issueId)
      return { ok: true }
    }

    const missing: string[] = []

    if (item.repos.length === 0) {
      missing.push('**Repos** — agrega los repos afectados separados por coma (ej: `subscriptions, buyer-web-front`)')
    }

    if (!item.type) {
      missing.push('**Task Type** — selecciona el tipo: `functional`, `technical`, `bug`, `spike` o `hotfix`')
    }

    if (missing.length > 0) {
      const reasons = missing.map((m) => m.replace(/\*\*/g, '').replace(/`[^`]+`/g, (s) => s.slice(1, -1)))
      log.warn({ id: item.id, title: item.title, missing: reasons }, 'Skipping — required fields missing')
      if (issueId) {
        const lines = missing.map((m) => `- ${m}`).join('\n')
        await upsertValidationComment(
          issueId,
          `## ⏸️ Este issue está en Queue pero no puede ser procesado\n\nFaltan los siguientes campos:\n\n${lines}\n\n_Este comentario se actualiza automáticamente en cada revisión._`,
        )
      }
      return { ok: false, reason: reasons.join('; ') }
    }

    if (issueId) {
      await clearValidationComment(issueId)
    }

    // For technical items in Approved status, check for open blocking dependencies
    if (item.type === 'technical' && item.status.toLowerCase() === 'approved') {
      const meta = this.meta
      if (meta) {
        try {
          const repoName = item.meta?.repoName as string | undefined
          const owner = item.meta?.owner as string | undefined
          const issueNumber = item.meta?.issueNumber as number | undefined
          const itemId = item.id

          if (repoName && owner && issueNumber) {
            const parentResolved = await resolveGithubRepo(repoName, owner)
            const blockers = await getBlockingIssues(parentResolved.owner, parentResolved.repo, issueNumber)
            const openBlockers = blockers.filter((b) => b.state === 'open')
            if (openBlockers.length > 0) {
              const list = openBlockers.map((b) => `- #${b.number} — ${b.title}`).join('\n')
              log.warn({ id: item.id, blockers: openBlockers.map((b) => b.number) }, 'Issue has open blockers — moving to Blocked')
              const statusField = meta.fields['Status']
              if (statusField) await updateItemStatus(meta.projectId, itemId, statusField, 'Blocked')
              if (issueId) {
                await addIssueComment(issueId, `## 🚫 Bloqueado por dependencias sin completar\n\n${list}\n\nCierra los issues bloqueantes y mueve a **Approved** para reintentar.`)
              }
              return { ok: false, reason: `Blocked by ${openBlockers.length} open issue(s)` }
            }
          }
        } catch (e) {
          log.warn({ err: e }, 'Could not check blocking issues — proceeding anyway')
        }
      }
    }

    return { ok: true }
  }

  getTransitionManager(item: IssueItem): TransitionManager {
    const meta = this.meta!
    const issueId = item.meta?.issueId as string
    const issueBody = item.meta?.issueBody as string ?? item.description
    const repoName = item.meta?.repoName as string | undefined
    const issueNumber = item.meta?.issueNumber as number | undefined

    return new GitHubTransitionManager(
      meta,
      item.id,
      issueId,
      issueBody,
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
    const stuck = items.filter(i => i.working)
    if (!stuck.length) return
    log.info({ count: stuck.length }, 'Resetting stuck agent_working items on startup')
    await Promise.all(stuck.map(i => clearItemWorking(this.meta!.projectId, i.id, workingField).catch(() => {})))
  }

}
