import { IssueManager, type Disposable } from '../issue-manager.js'
import type { IssueItem, ValidationResult, BroadcastFn } from '../types.js'
import type { TransitionManager } from '../transition-manager.js'
import { GitHubTransitionManager } from './github-transition-manager.js'
import { buildTechnicalSubIssueBody } from './sub-issue-builder.js'
import { buildRefinedBody } from './prd-formatter.js'
import {
  getProjectMeta,
  listProjectItems,
  updateItemStatus,
  addIssueComment,
  upsertValidationComment,
  clearValidationComment,
  createIssue,
  addProjectItem,
  setProjectTextField,
  addSubIssue,
  addBlockedBy,
  getBlockingIssues,
  type ProjectMeta,
  type ProjectItem,
} from '../../github/project.js'
import { gatherContextsForRepos } from '../../agents/context-gatherer.js'
import { orchestrateTechnicalDecompose } from '../../agents/orchestrator.js'
import { getRepoPaths, clearRepoCache, resolveGithubRepo } from '../../repos.js'
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
    meta: {
      issueId: item.issueId,
      issueNumber: item.issueNumber,
      repoName: item.repoName,
      issueBody: item.issueBody,
      projectId,
      owner,
    },
  }
}

export class GitHubIssueManager extends IssueManager {
  private meta: ProjectMeta | null = null
  private readonly processing = new Set<string>()

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
        }

        const config = await getProjectConfig()
        const configuredStatuses = config?.statuses?.map((s) => s.name) ?? []

        for (const statusName of configuredStatuses) {
          const items = await listProjectItems(this.meta.projectId, this.meta.fields, statusName)
          for (const item of items) {
            if (this.processing.has(item.id)) continue

            // Functional approved items need the decompose flow (GitHub-specific, creates sub-issues)
            // They don't fit the generic "agent produces text" model
            if (item.type.toLowerCase() === 'functional' && statusName.toLowerCase() === 'approved') {
              this.processApprovedFunctional(item).catch((err) =>
                log.error({ err, issue: item.issueNumber }, 'processApprovedFunctional threw')
              )
              continue
            }

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
    const missing: string[] = []

    if (item.repos.length === 0) {
      missing.push('**Repos** — agrega los repos afectados separados por coma (ej: `subscriptions, buyer-web-front`)')
    }

    if (!item.type) {
      missing.push('**Task Type** — selecciona el tipo: `functional`, `technical`, `bug`, `spike` o `hotfix`')
    }

    const issueId = item.meta?.issueId as string | undefined

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
    return new GitHubTransitionManager(
      meta,
      item.id,
      issueId,
      issueBody,
      this.broadcast,
    )
  }

  // ─── Approved functional → decompose to technical sub-issues ────────────

  private async processApprovedFunctional(item: ProjectItem): Promise<void> {
    if (this.processing.has(item.id)) return

    this.processing.add(item.id)
    const meta = this.meta!
    const statusField = meta.fields['Status']
    const itemLog = log.child({ issue: item.issueNumber, title: item.issueTitle })

    // Move to Implementing before starting
    if (statusField) await updateItemStatus(meta.projectId, item.id, statusField, 'Implementing')
    itemLog.info('Decomposing functional PRD → Implementing')
    this.broadcast({ type: 'github:decomposing', issueNumber: item.issueNumber, title: item.issueTitle })

    try {
      const repoNames = item.repos.split(',').map((r) => r.trim()).filter(Boolean)
      clearRepoCache()
      const repoEntries = await getRepoPaths(repoNames)
      const contexts = await gatherContextsForRepos(repoEntries)

      // Extract the functional PRD markdown (everything after the first ---)
      const functionalPrd = item.issueBody.split('\n\n---\n\n').slice(1).join('\n\n---\n\n').trim()

      const subTasks = await orchestrateTechnicalDecompose(
        {
          title: item.issueTitle,
          description: item.issueBody,
          type: item.type,
          repos: repoNames,
          issueId: item.issueId,
          issueNumber: item.issueNumber,
          repoName: item.repoName,
          itemId: item.id,
          projectId: meta.projectId,
        },
        functionalPrd,
        contexts,
      )

      itemLog.info({ count: subTasks.length }, 'Technical sub-tasks generated')

      const taskTypeField = meta.fields['Task Type']
      const reposField = meta.fields['Repos']
      const createdLinks: string[] = []

      // Map subTask → created issue for dependency linking after all issues exist
      const createdMap = new Map<typeof subTasks[number], { id: string; number: number }>()

      const parentResolved = await resolveGithubRepo(item.repoName, meta.owner)

      for (const sub of subTasks) {
        const subBody = buildTechnicalSubIssueBody(sub, item.issueNumber)
        const { owner: subOwner, repo: subRepo } = await resolveGithubRepo(sub.repo, meta.owner)
        const created = await createIssue(subOwner, subRepo, sub.title, subBody)
        itemLog.info({ number: created.number, owner: subOwner, repo: subRepo, localRepo: sub.repo, title: sub.title }, 'Created technical sub-issue')

        createdMap.set(sub, { id: created.id, number: created.number })

        // Add to project and set fields — Refined directly, no re-refinement needed
        const { itemId: subItemId } = await addProjectItem(meta.projectId, created.id)

        if (statusField) await updateItemStatus(meta.projectId, subItemId, statusField, 'Refined')
        if (taskTypeField) await updateItemStatus(meta.projectId, subItemId, taskTypeField, 'Technical')
        if (reposField) await setProjectTextField(meta.projectId, subItemId, reposField, sub.repo)

        // Link as native GitHub sub-issue
        await addSubIssue(parentResolved.owner, parentResolved.repo, item.issueNumber, created.numericId)

        createdLinks.push(`- #${created.number} — ${sub.title}`)
      }

      // Wire blocked-by relationships — match dependency by repo name
      for (const sub of subTasks) {
        const blockedIssue = createdMap.get(sub)
        if (!blockedIssue || !sub.dependencies.length) continue

        for (const dep of sub.dependencies) {
          const blockingSubTask = subTasks.find((s) => s !== sub && s.repo === dep.repo)
          const blockingIssue = blockingSubTask ? createdMap.get(blockingSubTask) : undefined
          if (!blockingIssue) continue

          try {
            await addBlockedBy(blockedIssue.id, blockingIssue.id)
            itemLog.info({ blocked: blockedIssue.number, blocking: blockingIssue.number }, 'Linked blocked-by dependency')
          } catch (e) {
            itemLog.warn({ err: e }, `Could not link blocked-by #${blockedIssue.number} ← #${blockingIssue.number}`)
          }
        }
      }

      if (statusField) await updateItemStatus(meta.projectId, item.id, statusField, 'Implementing')
      itemLog.info('Functional issue moved to Implementing, sub-issues created as Refined')
      this.broadcast({ type: 'github:decomposed', issueNumber: item.issueNumber, subCount: subTasks.length })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      itemLog.error({ err }, 'Technical decomposition failed — moving back to Refined')
      try {
        await addIssueComment(item.issueId, `## ⚠️ Technical decomposition error\n\n\`\`\`\n${msg}\n\`\`\`\n\nRevisa el error y mueve a **Approved** para reintentar.`)
        if (statusField) await updateItemStatus(meta.projectId, item.id, statusField, 'Refined')
      } catch (reportErr) {
        log.error({ err: reportErr }, 'Could not report error to GitHub')
      }
      this.broadcast({ type: 'github:error', issueNumber: item.issueNumber, error: msg })
    } finally {
      this.processing.delete(item.id)
    }
  }
}
