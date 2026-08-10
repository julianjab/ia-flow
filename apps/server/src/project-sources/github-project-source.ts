import {
  type ProjectMeta,
  getProjectMeta,
  listProjectItems,
  setProjectTextField,
} from '../github/project.js'
import type { ProjectSource, SourceItem, StatusOption } from './types.js'

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
        meta: {
          issueNumber: it.issueNumber,
          repoName: it.repoName,
          type: it.type,
          priority: it.priority,
          size: it.size,
          working: it.working,
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
}
