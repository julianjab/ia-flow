import chokidar from 'chokidar'
import { join, basename } from 'path'
import { readTask, moveTask, updateTask, getQueueDir, getStatusDirs } from './store.js'
import { getRepoPaths } from './repos.js'
import { gatherContextsForRepos } from './agents/context-gatherer.js'
import { refineFunctionalTask } from './agents/functional-refiner.js'
import { generateTechnicalPRDs } from './agents/technical-prd.js'
import type { Task } from '@ia-flow/shared'

type BroadcastFn = (msg: object) => void

let broadcast: BroadcastFn = () => {}
const processing = new Set<string>()

export function setBroadcast(fn: BroadcastFn) {
  broadcast = fn
}

async function processTask(filePath: string) {
  const id = basename(filePath, '.yaml')

  if (processing.has(id)) return
  processing.add(id)

  console.log(`[daemon] Processing task: ${id}`)

  try {
    // Wait a tick to ensure the file is fully written
    await new Promise((r) => setTimeout(r, 200))

    const task = await readTask(filePath)
    if (!task) {
      console.error(`[daemon] Could not read task from ${filePath}`)
      return
    }

    if (task.status !== 'queued') {
      console.log(`[daemon] Skipping ${id} — status is ${task.status}`)
      return
    }

    // Move to refining
    const refiningTask = await moveTask(task, 'refining')
    broadcast({ type: 'task:updated', task: refiningTask })

    // Gather repo contexts
    const repoEntries = await getRepoPaths(task.repos)
    const contexts = await gatherContextsForRepos(repoEntries)

    let refinedTask: Task
    try {
      if (task.type === 'functional') {
        const prd = await refineFunctionalTask(refiningTask, contexts)
        const withPrd: Task = { ...refiningTask, prd }
        const moved = await moveTask(withPrd, 'refined')
        refinedTask = moved
      } else {
        const prds = await generateTechnicalPRDs(refiningTask, contexts)
        const withPrd: Task = { ...refiningTask, prd: prds }
        const moved = await moveTask(withPrd, 'refined')
        refinedTask = moved
      }

      broadcast({ type: 'task:updated', task: refinedTask })
      console.log(`[daemon] Task ${id} refined successfully`)
    } catch (err) {
      // On error, move back to queue with error note
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
  const queueDir = getQueueDir()

  console.log(`[daemon] Watching ${queueDir}`)

  const watcher = chokidar.watch(queueDir, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  })

  watcher
    .on('add', (filePath) => {
      if (filePath.endsWith('.yaml')) {
        processTask(filePath).catch((err) =>
          console.error(`[daemon] Unhandled error processing ${filePath}:`, err),
        )
      }
    })
    .on('error', (err) => console.error('[daemon] Watcher error:', err))

  return watcher
}
