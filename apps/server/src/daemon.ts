import chokidar from 'chokidar'
import { basename } from 'path'
import { readTask, moveTask, updateTask, getQueueDir, getTasksRoot } from './store.js'
import { getRepoPaths } from './repos.js'
import { gatherContextsForRepos } from './agents/context-gatherer.js'
import { refineFunctionalTask } from './agents/functional-refiner.js'
import { generateTechnicalPRDs } from './agents/technical-prd.js'
import { runAgent } from './agents/agent-engine.js'
import { getProjectConfig } from './config/project-config.js'
import type { Task } from '@ia-flow/shared'

type BroadcastFn = (msg: object) => void

let broadcast: BroadcastFn = () => {}
const processing = new Set<string>()

export function setBroadcast(fn: BroadcastFn) {
  broadcast = fn
}

async function processTask(filePath: string) {
  if (!filePath.endsWith('.yaml')) return

  const id = basename(filePath, '.yaml')

  if (processing.has(id)) return
  processing.add(id)

  console.log(`[daemon] Processing task: ${id}`)

  try {
    await new Promise((r) => setTimeout(r, 200))

    const task = await readTask(filePath)
    if (!task) {
      console.error(`[daemon] Could not read task from ${filePath}`)
      return
    }

    // Try new agent engine first
    const config = await getProjectConfig()
    if (config) {
      const hasAgent = config.agents.some((a) => a.onStatus === task.status)
      if (hasAgent) {
        await runAgent(task, broadcast)
        return
      }
    }

    // Fall back to legacy logic for 'queued' status
    if (task.status !== 'queued') {
      console.log(`[daemon] Skipping ${id} — no agent for status '${task.status}'`)
      return
    }

    const refiningTask = await moveTask(task, 'refining')
    broadcast({ type: 'task:updated', task: refiningTask })

    const repoEntries = await getRepoPaths(task.repos)
    const contexts = await gatherContextsForRepos(repoEntries)

    let refinedTask: Task
    try {
      if (task.type === 'functional') {
        const prd = await refineFunctionalTask(refiningTask, contexts)
        const withPrd: Task = { ...refiningTask, prd }
        refinedTask = await moveTask(withPrd, 'refined')
      } else {
        const prds = await generateTechnicalPRDs(refiningTask, contexts)
        const withPrd: Task = { ...refiningTask, prd: prds }
        refinedTask = await moveTask(withPrd, 'refined')
      }

      broadcast({ type: 'task:updated', task: refinedTask })
      console.log(`[daemon] Task ${id} refined successfully`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[daemon] Agent error for ${id}:`, errMsg)
      const errTask: Task = { ...refiningTask, error: errMsg }
      await updateTask(errTask)
      const requeued = await moveTask(errTask, 'queued')
      broadcast({ type: 'task:updated', task: requeued })
    }
  } finally {
    processing.delete(id)
  }
}

export function startDaemon() {
  const tasksRoot = getTasksRoot()

  console.log(`[daemon] Watching ${tasksRoot}`)

  // Watch all task dirs (depth 1 catches files in immediate subdirs)
  const watcher = chokidar.watch(tasksRoot, {
    persistent: true,
    ignoreInitial: false,
    depth: 1,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  })

  watcher
    .on('add', (filePath) => {
      processTask(filePath).catch((err) =>
        console.error(`[daemon] Unhandled error processing ${filePath}:`, err),
      )
    })
    .on('error', (err) => console.error('[daemon] Watcher error:', err))

  return watcher
}
