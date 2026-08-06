import { Hono } from 'hono'
import { getAllTasks, getTask, writeTask, listTaskStatuses } from '../store.js'
import { listRepos } from '../repos.js'
import { createLogger } from '../logger.js'
import { listDbRepos, upsertDbRepo, deleteDbRepo } from '../db.js'
import type { Task, RepoMappingEntry } from '@ia-flow/shared'

const log = createLogger('tasks')

type BroadcastFn = (msg: object) => void

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
