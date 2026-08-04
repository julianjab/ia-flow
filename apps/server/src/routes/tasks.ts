import { Hono } from 'hono'
import { getAllTasks, getTask, writeTask, moveTask } from '../store.js'
import { listRepos } from '../repos.js'
import type { Task } from '@ia-flow/shared'

type BroadcastFn = (msg: object) => void

export function createTasksRouter(broadcast: BroadcastFn) {
  const router = new Hono()

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
      }>()

      if (!body.title || !body.description || !body.type || !body.repos?.length) {
        return c.json({ error: 'title, description, type, and repos are required' }, 400)
      }

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

  // POST /api/tasks/:id/approve — approve a refined task
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

      return c.json({ task: approved })
    } catch (err) {
      console.error(`[routes/tasks] POST /tasks/${id}/approve error:`, err)
      return c.json({ error: 'Failed to approve task' }, 500)
    }
  })

  return router
}

export function createReposRouter() {
  const router = new Hono()

  // GET /api/repos — list available repos
  router.get('/', async (c) => {
    try {
      const repos = await listRepos()
      return c.json({ repos })
    } catch (err) {
      console.error('[routes/repos] GET /repos error:', err)
      return c.json({ error: 'Failed to list repos' }, 500)
    }
  })

  return router
}
