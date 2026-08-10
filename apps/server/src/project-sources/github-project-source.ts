import {
  type ProjectMeta,
  clearItemWorking,
  getProjectMeta,
  listProjectItems,
  setProjectTextField,
} from '../github/project.js'
import { GitHubTransitionManager } from '../issue-managers/github/github-transition-manager.js'
import type { TransitionManager } from '../issue-managers/transition-manager.js'
import type { BroadcastFn, IssueItem } from '../issue-managers/types.js'
import { createLogger } from '../logger.js'
import type { ProjectSource, SourceItem, StatusOption } from './types.js'

const log = createLogger('github-project-source')

// Per-URL caches. Meta stays fresh for 5 min, items for 1 min — matches the
// TTLs the routes used before and avoids hammering GitHub when two projects
// live in different tabs of the same user session.
interface MetaEntry {
  at: number
  meta: ProjectMeta
}
interface ItemsEntry {
  at: number
  items: SourceItem[]
}
const META_TTL_MS = 5 * 60 * 1000
const ITEMS_TTL_MS = 60 * 1000

const metaCache = new Map<string, MetaEntry>()
const itemsCache = new Map<string, ItemsEntry>()

export function invalidateGitHubCache(url: string): void {
  metaCache.delete(url)
  itemsCache.delete(url)
}

async function loadMeta(url: string, refresh?: boolean): Promise<ProjectMeta> {
  const cached = metaCache.get(url)
  if (!refresh && cached && Date.now() - cached.at < META_TTL_MS) return cached.meta
  const meta = await getProjectMeta(url)
  metaCache.set(url, { at: Date.now(), meta })
  return meta
}

// Public helper: routes that need the raw meta (fields other than Status,
// removeStatusOptions, etc.) can reach into the same cache instead of calling
// getProjectMeta directly, so invalidation stays coherent.
export async function getCachedGitHubMeta(url: string, refresh?: boolean): Promise<ProjectMeta> {
  return loadMeta(url, refresh)
}

export class GitHubProjectSource implements ProjectSource {
  readonly kind = 'github'

  constructor(private readonly url: string) {}

  async getStatuses(opts?: { refresh?: boolean }): Promise<StatusOption[]> {
    const meta = await loadMeta(this.url, opts?.refresh)
    const statusField = meta.fields.Status
    if (!statusField?.options) return []
    return statusField.options.map((o) => ({ name: o.name }))
  }

  async getItems(opts?: { status?: string; refresh?: boolean }): Promise<SourceItem[]> {
    const cached = itemsCache.get(this.url)
    let items: SourceItem[]
    if (!opts?.refresh && cached && Date.now() - cached.at < ITEMS_TTL_MS) {
      items = cached.items
    } else {
      const meta = await loadMeta(this.url, opts?.refresh)
      const raw = await listProjectItems(meta.projectId, meta.fields)
      items = raw.map((it) => ({
        id: it.id,
        title: it.issueTitle,
        status: it.status,
        repos: it.repos,
        // Everything the daemon's TransitionManager needs later goes here —
        // consumers treat this blob as opaque.
        meta: {
          issueId: it.issueId,
          issueNumber: it.issueNumber,
          repoName: it.repoName,
          type: it.type,
          priority: it.priority,
          size: it.size,
          working: it.working,
          issueBody: it.issueBody,
          issueUrl: `https://github.com/${meta.owner}/${it.repoName}/issues/${it.issueNumber}`,
          // The GitHub Project v2 node id (used by the transition manager).
          ghProjectId: meta.projectId,
          owner: meta.owner,
        },
      }))
      itemsCache.set(this.url, { at: Date.now(), items })
    }
    if (opts?.status) items = items.filter((i) => i.status === opts.status)
    return items
  }

  async setItemField(itemId: string, field: string, value: string): Promise<void> {
    const meta = await loadMeta(this.url)
    const f = meta.fields[field]
    if (!f) throw new Error(`Field '${field}' not found in project`)
    await setProjectTextField(meta.projectId, itemId, f, value)
    // Any mutation invalidates the items cache — statuses (meta) are unchanged.
    itemsCache.delete(this.url)
  }

  // ─── Daemon-facing (used by PollingIssueManager) ────────────────────────

  toIssueItem(item: SourceItem): IssueItem {
    const meta = item.meta ?? {}
    const rawBody = (meta.issueBody as string | undefined) ?? ''
    // Body may embed prior AI history separated by "\n\n---\n\n" — the daemon
    // wants only the human-authored top block.
    const description = rawBody.split('\n\n---\n\n')[0].trim()
    return {
      id: item.id,
      title: item.title,
      description,
      type: ((meta.type as string) ?? '').toLowerCase(),
      repos: item.repos
        ? item.repos
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean)
        : [],
      status: item.status,
      agentWorking: meta.working === true,
      meta,
    }
  }

  getTransitionManager(item: IssueItem, broadcast: BroadcastFn): TransitionManager {
    const m = item.meta ?? {}
    const ghProjectId = m.ghProjectId as string | undefined
    if (!ghProjectId) {
      throw new Error(`Item ${item.id} missing meta.ghProjectId — not a GitHub-sourced item`)
    }
    const issueId = m.issueId as string
    const repoName = m.repoName as string | undefined
    const issueNumber = m.issueNumber as number | undefined
    // Rehydrate ProjectMeta from cache — the poll cycle populated it just
    // before dispatch, so the entry should be warm.
    const cached = metaCache.get(this.url)?.meta
    if (!cached) {
      throw new Error(`GitHub project meta not cached for ${this.url}`)
    }
    return new GitHubTransitionManager(cached, item.id, issueId, broadcast, repoName, issueNumber)
  }

  // Crash-recovery: any item left with Working=Yes from a previous run gets
  // reset so we don't skip it forever (poll() skips working=true items).
  async onDaemonStart(): Promise<void> {
    try {
      const meta = await loadMeta(this.url)
      const workingField = meta.fields.Working
      if (!workingField) return
      const items = await listProjectItems(meta.projectId, meta.fields)
      const stuck = items.filter((i) => i.working)
      if (!stuck.length) return
      log.info({ url: this.url, count: stuck.length }, 'Resetting stuck agent_working items')
      await Promise.all(
        stuck.map((i) =>
          clearItemWorking(meta.projectId, i.id, workingField).catch(() => {
            /* non-fatal */
          }),
        ),
      )
    } catch (err) {
      log.warn({ err, url: this.url }, 'onDaemonStart failed — will retry on first poll')
    }
  }
}
