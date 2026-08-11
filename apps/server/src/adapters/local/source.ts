import type { ITaskRepository } from '../../domain/ports/ITaskRepository.js'
import type { IssueItem } from '../../issue-managers/types.js'
import type {
  Blocker,
  ProjectSource,
  SourceItem,
  SourceProjectField,
  StatusOption,
} from '../../project-sources/types.js'
import { parseBlockedBy } from './blocked-by.js'

// File-backed source. Status list comes from the tasks/ directory tree — one
// dir per status name. Items still flow through LocalIssueManager (file
// watcher); getItems returns [] here because the daemon owns the read side.
export class LocalProjectSource implements ProjectSource {
  readonly kind = 'local'

  constructor(private taskRepo: ITaskRepository) {}

  async getStatuses(): Promise<StatusOption[]> {
    const names = await this.taskRepo.listStatuses()
    return names.map((name) => ({ name }))
  }

  async getItems(): Promise<SourceItem[]> {
    return []
  }

  async getFields(): Promise<SourceProjectField[]> {
    // Local source only knows Status (derived from tasks/<status>/ dirs).
    const statuses = await this.getStatuses()
    return [{ name: 'Status', dataType: 'SINGLE_SELECT', options: statuses.map((s) => s.name) }]
  }

  async getItemById(id: string): Promise<SourceItem | null> {
    const task = await this.taskRepo.getById(id)
    if (!task) return null
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      repos: task.repos?.join(', '),
      meta: { description: task.description },
    }
  }

  async getBlockers(item: IssueItem): Promise<Blocker[]> {
    // Same shape as LocalIssueManager.getBlockers — the source needs its own
    // impl so REST callers (web UI) can query blockers without going through
    // the file watcher path. Duplicates the parse logic; kept small by
    // sharing the parser helper.
    const description = item.description ?? (item.meta?.description as string) ?? ''
    const ids = parseBlockedBy(description)
    if (!ids.length) return []
    const out: Blocker[] = []
    // Any FS repo exposes `getFilePath` (see FsTaskRepository) — we cast to
    // access it without touching the port interface, since this is a
    // source-local concern.
    const repoAny = this.taskRepo as unknown as {
      getFilePath?(id: string): Promise<string | null>
    }
    for (const id of ids) {
      const blocker = await this.taskRepo.getById(id)
      if (!blocker) {
        out.push({ id, ref: id, title: '(not found)' })
        continue
      }
      if ((blocker.status ?? '').toLowerCase() === 'done') continue
      const filePath = repoAny.getFilePath ? await repoAny.getFilePath(id) : null
      out.push({
        id,
        ref: id,
        title: blocker.title,
        status: blocker.status,
        ...(filePath && { url: `vscode://file/${filePath}` }),
      })
    }
    return out
  }
}
