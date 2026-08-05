import { Hono } from 'hono'
import { getAllTasks, getTask, writeTask, moveTask, updateTask, listTaskStatuses } from '../store.js'
import { getRepoPaths, listRepos } from '../repos.js'
import { gatherContextsForRepos } from '../agents/context-gatherer.js'
import { orchestrateImplement } from '../agents/orchestrator.js'
import { createLogger } from '../logger.js'
import { listDbRepos, upsertDbRepo, deleteDbRepo } from '../db.js'
import type { Task, RepoMappingEntry } from '@ia-flow/shared'

const log = createLogger('tasks')

type BroadcastFn = (msg: object) => void

// ─── Implementation trigger ───────────────────────────────────────────────────
// Resolves repo paths via repoMappings (with path fallback), builds contexts,
// and calls orchestrateImplement. Runs async — callers must not await.

async function runImplementation(task: Task, broadcast: BroadcastFn): Promise<void> {
  if (!task.prd) {
    log.warn({ id: task.id }, 'runImplementation called but task has no PRD — skipping')
    return
  }

  try {
    log.info({ id: task.id, repos: task.repos }, 'Starting local implementation')

    const repoEntries = await getRepoPaths(task.repos)
    const contexts = await gatherContextsForRepos(repoEntries)
    const prdJson = JSON.stringify(task.prd)

    const outputs = await orchestrateImplement(
      {
        title: task.title,
        description: task.description,
        type: task.type,
        repos: task.repos,
      },
      prdJson,
      contexts,
    )

    const summary = outputs
      .map((o, i) => `${task.repos[i] ?? 'repo'}: ${o.tmuxSession ? o.attachCmd : 'done'}`)
      .join('\n')

    log.info({ id: task.id, summary }, 'Implementation launched')
    broadcast({ type: 'task:implementing', task, summary })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ id: task.id, err }, 'Implementation failed')
    const withError: Task = { ...task, error: msg }
    await updateTask(withError)
    broadcast({ type: 'task:updated', task: withError })
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createTasksRouter(broadcast: BroadcastFn) {
  const router = new Hono()

  // GET /api/tasks/statuses — list all status dirs
  router.get('/statuses', async (c) => {
    const statuses = await listTaskStatuses()
    return c.json({ statuses })
  })

  // GET /api/tasks — list all tasks
  router.get('/', async (c) => {
    try {
      const tasks = await getAllTasks()
      return c.json({ tasks })
    } catch (err) {
      console.error('[routes/tasks] GET /tasks error:', err)
      return c.json({ error: 'Failed to list tasks' }, 500)
    }
  })

  // POST /api/tasks — create a new task
  router.post('/', async (c) => {
    try {
      const body = await c.req.json<{
        title: string
        description: string
        type: 'functional' | 'technical'
        repos: string[]
        issueNumber?: number
        issueUrl?: string
      }>()

      if (!body.title || !body.description || !body.type || !body.repos?.length) {
        return c.json({ error: 'title, description, type, and repos are required' }, 400)
      }

      const parsedNumber = body.issueNumber ?? (body.issueUrl
        ? Number(body.issueUrl.match(/\/issues\/(\d+)/)?.[1] ?? '') || undefined
        : undefined)

      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const datePart = [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
      ].join('')
      const timePart = [
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
      ].join('')
      const slug = body.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40)

      const task: Task = {
        id: `${datePart}-${timePart}-${slug}`,
        title: body.title,
        description: body.description,
        type: body.type,
        repos: body.repos,
        status: 'queued',
        created_at: now.toISOString(),
        ...(parsedNumber !== undefined && { issueNumber: parsedNumber }),
        ...(body.issueUrl && { issueUrl: body.issueUrl }),
      }

      await writeTask(task)
      broadcast({ type: 'task:created', task })

      return c.json({ task }, 201)
    } catch (err) {
      console.error('[routes/tasks] POST /tasks error:', err)
      return c.json({ error: 'Failed to create task' }, 500)
    }
  })

  // GET /api/tasks/:id — get single task
  router.get('/:id', async (c) => {
    const id = c.req.param('id')
    try {
      const task = await getTask(id)
      if (!task) return c.json({ error: 'Task not found' }, 404)
      return c.json({ task })
    } catch (err) {
      console.error(`[routes/tasks] GET /tasks/${id} error:`, err)
      return c.json({ error: 'Failed to get task' }, 500)
    }
  })

  // POST /api/tasks/:id/approve — approve a refined task and launch implementation
  router.post('/:id/approve', async (c) => {
    const id = c.req.param('id')
    try {
      const task = await getTask(id)
      if (!task) return c.json({ error: 'Task not found' }, 404)
      if (task.status !== 'refined') {
        return c.json({ error: `Task is in status '${task.status}', expected 'refined'` }, 400)
      }

      const approved = await moveTask(task, 'approved')
      broadcast({ type: 'task:approved', task: approved })

      // Launch implementation async — resolve paths and workflow from repoMappings
      runImplementation(approved, broadcast).catch((err) =>
        log.error({ id, err }, 'Unhandled error in runImplementation'),
      )

      return c.json({ task: approved })
    } catch (err) {
      console.error(`[routes/tasks] POST /tasks/${id}/approve error:`, err)
      return c.json({ error: 'Failed to approve task' }, 500)
    }
  })

  // POST /api/tasks/:id/implement — (re-)launch implementation for an approved task
  router.post('/:id/implement', async (c) => {
    const id = c.req.param('id')
    try {
      const task = await getTask(id)
      if (!task) return c.json({ error: 'Task not found' }, 404)
      if (task.status !== 'approved') {
        return c.json({ error: `Task is in status '${task.status}', expected 'approved'` }, 400)
      }
      if (!task.prd) {
        return c.json({ error: 'Task has no PRD — cannot implement' }, 400)
      }

      runImplementation(task, broadcast).catch((err) =>
        log.error({ id, err }, 'Unhandled error in runImplementation'),
      )

      return c.json({ ok: true, message: 'Implementation started' })
    } catch (err) {
      console.error(`[routes/tasks] POST /tasks/${id}/implement error:`, err)
      return c.json({ error: 'Failed to start implementation' }, 500)
    }
  })

  return router
}

export function createReposRouter() {
  const router = new Hono()

  // GET /api/repos — list auto-discovered repos (used for path autocomplete)
  router.get('/', async (c) => {
    try {
      const repos = await listRepos()
      return c.json({ repos })
    } catch (err) {
      console.error('[routes/repos] GET /repos error:', err)
      return c.json({ error: 'Failed to list repos' }, 500)
    }
  })

  // GET /api/repos/mappings — list all DB repo mappings
  router.get('/mappings', (c) => {
    const mappings = listDbRepos()
    return c.json({ mappings })
  })

  // POST /api/repos/mappings — upsert a single repo mapping
  router.post('/mappings', async (c) => {
    try {
      const body = await c.req.json<{ name: string } & RepoMappingEntry>()
      if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
      upsertDbRepo({
        name: body.name.trim(),
        path: body.path,
        githubOwner: body.githubOwner,
        githubRepo: body.githubRepo,
        workflow: body.workflow,
      })
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: 'Invalid body' }, 400)
    }
  })

  // DELETE /api/repos/mappings/:name — remove a repo mapping
  router.delete('/mappings/:name', (c) => {
    const name = c.req.param('name')
    deleteDbRepo(name)
    return c.json({ ok: true })
  })

  return router
}
