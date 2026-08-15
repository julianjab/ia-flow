import type { Task } from '@ia-flow/shared'
import type {
  Blocker,
  CreateItemInput,
  ITaskRepository,
  IssueItem,
  ProjectSource,
  SourceItem,
  SourceProjectField,
  StatusOption,
  UpdateItemInput,
} from '../contract.js'
import { parseBlockedBy } from './blocked-by.js'

function generateTaskId(title: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const datePart = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join('')
  const timePart = [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('')
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return `${datePart}-${timePart}-${slug}`
}

function taskToSourceItem(task: Task, url?: string): SourceItem {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    repos: task.repos?.join(', '),
    ...(url && { url }),
    meta: { description: task.description, type: task.type },
  }
}

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

  async createItem(input: CreateItemInput): Promise<SourceItem> {
    const task: Task = {
      id: generateTaskId(input.title),
      title: input.title,
      description: input.description ?? '',
      type: input.type ?? 'functional',
      repos: input.repos ?? [],
      status: input.status ?? 'queued',
      created_at: new Date().toISOString(),
    }
    await this.taskRepo.save(task)
    return taskToSourceItem(task, await this.fileUrl(task.id))
  }

  async updateItem(id: string, patch: UpdateItemInput): Promise<SourceItem> {
    const current = await this.taskRepo.getById(id)
    if (!current) throw new Error(`Task '${id}' not found`)
    const next: Task = {
      ...current,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.type !== undefined && { type: patch.type }),
      ...(patch.repos !== undefined && { repos: patch.repos }),
    }
    if (patch.status && patch.status !== current.status) {
      const moved = await this.taskRepo.move(next, patch.status)
      return taskToSourceItem(moved, await this.fileUrl(moved.id))
    }
    await this.taskRepo.update(next)
    return taskToSourceItem(next, await this.fileUrl(next.id))
  }

  private async fileUrl(id: string): Promise<string | undefined> {
    const repoAny = this.taskRepo as unknown as {
      getFilePath?(id: string): Promise<string | null>
    }
    if (!repoAny.getFilePath) return undefined
    const path = await repoAny.getFilePath(id)
    return path ? `vscode://file/${path}` : undefined
  }

  async deleteItem(id: string): Promise<void> {
    await this.taskRepo.delete(id)
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
