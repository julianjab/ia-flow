import chokidar from 'chokidar'
import { basename } from 'path'
import { IssueManager, type Disposable } from '../issue-manager.js'
import type { IssueItem } from '../types.js'
import type { TransitionManager } from '../transition-manager.js'
import { LocalTransitionManager } from './local-transition-manager.js'
import { readTask, getTasksRoot } from '../../store.js'
import type { Task } from '@ia-flow/shared'
import { createLogger } from '../../logger.js'

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
    const tasksRoot = getTasksRoot()
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
        const task = await readTask(filePath)
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

    return { dispose: () => { watcher.close() } }
  }

  getTransitionManager(_item: IssueItem): TransitionManager {
    return new LocalTransitionManager()
  }
}
