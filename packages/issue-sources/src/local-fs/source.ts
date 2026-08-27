import { basename } from 'path'
import type { Task } from '@ia-flow/shared'
import chokidar from 'chokidar'
import type {
  Blocker,
  BroadcastFn,
  CreateItemInput,
  Disposable,
  ITaskRepository,
  IssueItem,
  ProjectSource,
  SourceItem,
  SourceProjectField,
  StatusOption,
  TaskSource,
  UpdateItemInput,
  WatchOptions,
} from '../contract.js'
import { createLogger } from '../logger.js'
import { parseBlockedBy } from './blocked-by.js'
import { LocalTaskSource } from './task-source.js'

const log = createLogger('local-project-source')

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

// Task → SourceItem. `meta` carries `description`/`type` (read back out by
// toIssueItem() below) PLUS every other Task field that isn't part of the
// SourceItem shape (prd, sections, error, issueNumber, issueUrl, approved_at,
// created_at, …) — same round-trip fidelity the old ad-hoc
// LocalIssueManager.taskToIssueItem() had, just split across the
// Task→SourceItem→IssueItem hop instead of converting directly.
function taskToSourceItem(task: Task, url?: string): SourceItem {
  const { id, title, description, type, repos, status, ...rest } = task
  return {
    id,
    title,
    status,
    repos: repos?.join(', '),
    ...(url && { url }),
    // `slackThreadUrl` sale de la sección `Slack` del YAML — es el soporte que
    // esta fuente tiene para el hilo de review (ver get/setSlackThreadUrl). Va
    // resuelto acá para que la web dibuje el tag sin saber de qué sección salió.
    meta: { description, type, ...rest, slackThreadUrl: task.sections?.[SLACK_SECTION] },
  }
}

/** Sección del YAML donde local-fs guarda el link del hilo de Slack. */
const SLACK_SECTION = 'Slack'

// File-backed source. Status list comes from the tasks/ directory tree — one
// dir per status name.
export class LocalProjectSource implements ProjectSource {
  readonly kind = 'local'

  constructor(private taskRepo: ITaskRepository) {}

  async getStatuses(): Promise<StatusOption[]> {
    const names = await this.taskRepo.listStatuses()
    return names.map((name) => ({ name }))
  }

  async getItems(): Promise<SourceItem[]> {
    const tasks = await this.taskRepo.listAll()
    return Promise.all(
      tasks.map(async (task) => taskToSourceItem(task, await this.fileUrl(task.id))),
    )
  }

  async getFields(): Promise<SourceProjectField[]> {
    // Local source only knows Status (derived from tasks/<status>/ dirs).
    const statuses = await this.getStatuses()
    return [{ name: 'Status', dataType: 'SINGLE_SELECT', options: statuses.map((s) => s.name) }]
  }

  async getItemById(id: string): Promise<SourceItem | null> {
    const task = await this.taskRepo.getById(id)
    if (!task) return null
    return taskToSourceItem(task, await this.fileUrl(id))
  }

  getTransitionManager(_item: IssueItem, _broadcast: BroadcastFn): TaskSource {
    return new LocalTaskSource(this.taskRepo)
  }

  async getSlackThreadUrl(item: IssueItem): Promise<string | undefined> {
    const sections = item.meta?.sections as Record<string, string> | undefined
    return sections?.[SLACK_SECTION] || undefined
  }

  async setSlackThreadUrl(item: IssueItem, url: string): Promise<void> {
    const task = await this.taskRepo.getById(item.id)
    if (!task) throw new Error(`Task '${item.id}' not found`)
    await this.taskRepo.update({ ...task, sections: { ...task.sections, [SLACK_SECTION]: url } })
  }

  /**
   * Reconstructs the IssueItem shape the old LocalIssueManager built
   * directly from a Task (taskToIssueItem, now removed) — description/type
   * come back out of `meta`, everything else in `meta` (prd, sections,
   * error, issueNumber, issueUrl, approved_at, …) passes through untouched,
   * same as before.
   */
  toIssueItem(item: SourceItem): IssueItem {
    const { description, type, ...rest } = (item.meta ?? {}) as Record<string, unknown>
    return {
      id: item.id,
      title: item.title,
      description: (description as string) ?? '',
      type: (type as string) ?? '',
      repos: item.repos
        ? item.repos
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean)
        : [],
      status: item.status,
      meta: rest,
    }
  }

  /**
   * Push-based watch — migrated from the old LocalIssueManager.start(), same
   * chokidar setup and debounce-free semantics (each file `add` is already
   * an atomic, complete write thanks to awaitWriteFinish). `opts` is
   * ignored: an fs watcher has no polling/webhook mode distinction.
   */
  watch(onItems: (items: SourceItem[]) => void, _opts: WatchOptions): Disposable {
    const { taskRepo } = this
    const tasksRoot = taskRepo.root()
    const processing = new Set<string>()

    const watcher = chokidar.watch(tasksRoot, {
      persistent: true,
      ignoreInitial: false,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    })

    watcher.on('add', async (filePath: string) => {
      if (!filePath.endsWith('.yaml')) return
      const id = basename(filePath, '.yaml')
      if (processing.has(id)) return
      processing.add(id)
      try {
        await new Promise((r) => setTimeout(r, 200))
        const task = await taskRepo.read(filePath)
        if (!task) return
        log.debug({ id }, 'Dispatching local task')
        onItems([taskToSourceItem(task, await this.fileUrl(id))])
      } catch (err) {
        log.error({ err, id }, 'Error reading local task')
      } finally {
        processing.delete(id)
      }
    })

    watcher.on('error', (err) => log.error({ err }, 'Watcher error'))
    log.info({ path: tasksRoot }, 'Local watcher started')

    return {
      dispose: () => {
        watcher.close()
      },
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
      if ((blocker.status ?? '').toLowerCase() === 'done') {
        log.debug({ id }, `Skipping blocker ${id} — already done`)
        continue
      }
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
