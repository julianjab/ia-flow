import { basename } from 'path'
import type { Task } from '@ia-flow/shared'
import chokidar from 'chokidar'
import { taskRepo } from '../../composition/container.js'
import { type Disposable, IssueManager } from '../../issue-managers/issue-manager.js'
import type { TransitionManager } from '../../issue-managers/transition-manager.js'
import type { IssueItem } from '../../issue-managers/types.js'
import { createLogger } from '../../logger.js'
import { parseBlockedBy } from './blocked-by.js'
import { LocalTransitionManager } from './transition-manager.js'

const log = createLogger('local-issue-manager')

// Converts Task → IssueItem. The spread into meta preserves prd, error, issueNumber, etc.
export function taskToIssueItem(task: Task): IssueItem {
  const { id, title, description, type, repos, status, ...rest } = task
  return { id, title, description, type, repos, status, meta: rest as Record<string, unknown> }
}

// Converts IssueItem → Task. Restores meta fields back into the Task shape.
export function issueItemToTask(item: IssueItem): Task {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    type: item.type as Task['type'],
    repos: item.repos,
    status: item.status as Task['status'],
    created_at: (item.meta?.created_at as string | undefined) ?? new Date().toISOString(),
    ...(item.meta?.prd !== undefined && { prd: item.meta.prd as Task['prd'] }),
    ...(item.meta?.sections !== undefined && { sections: item.meta.sections as Task['sections'] }),
    ...(item.meta?.error !== undefined && { error: item.meta.error as string }),
    ...(item.meta?.issueNumber !== undefined && { issueNumber: item.meta.issueNumber as number }),
    ...(item.meta?.issueUrl !== undefined && { issueUrl: item.meta.issueUrl as string }),
    ...(item.meta?.approved_at !== undefined && { approved_at: item.meta.approved_at as string }),
  }
}

export class LocalIssueManager extends IssueManager {
  start(dispatch: (item: IssueItem) => Promise<void>): Disposable {
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
        await dispatch(taskToIssueItem(task))
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

  getTransitionManager(_item: IssueItem): TransitionManager {
    return new LocalTransitionManager()
  }

  async getBlockers(item: IssueItem) {
    const ids = parseBlockedBy(item.description ?? '')
    if (!ids.length) return []
    const unfinished: Array<{
      id: string
      ref?: string
      title?: string
      status?: string
      url?: string
    }> = []
    for (const id of ids) {
      const blocker = await taskRepo.getById(id)
      if (!blocker) {
        // Missing blocker = treat as unfinished (user referenced an ID that
        // isn't in the repo — better to block than silently ignore).
        unfinished.push({ id, ref: id, title: '(not found)' })
        continue
      }
      if ((blocker.status ?? '').toLowerCase() === 'done') continue
      const filePath = await taskRepo.getFilePath(id)
      unfinished.push({
        id,
        ref: id,
        title: blocker.title,
        status: blocker.status,
        ...(filePath && { url: `vscode://file/${filePath}` }),
      })
    }
    return unfinished
  }
}
