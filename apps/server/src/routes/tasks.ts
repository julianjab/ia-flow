import type { RepoMappingEntry, Task } from '@ia-flow/shared'
import { Hono } from 'hono'
import { projectRepo, repoRepo, settingsRepo, taskRepo } from '../composition/container.js'
import { createLogger } from '../logger.js'
import { clearRepoCache, listRepos } from '../repos.js'

const log = createLogger('tasks')

type BroadcastFn = (msg: object) => void

// Accepts:
//   https://github.com/owner/repo(.git)?(/...)?
//   http://github.com/owner/repo
//   git@github.com:owner/repo(.git)?
//   github.com/owner/repo
//   owner/repo
export function parseGithubUrl(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const stripped = trimmed
    .replace(/^https?:\/\//, '')
    .replace(/^git@github\.com:/, 'github.com/')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const parts = stripped.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const [owner, repo] = parts
  if (!owner || !repo) return null
  return { owner, repo }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createTasksRouter(broadcast: BroadcastFn) {
  const router = new Hono()

  // GET /api/tasks/statuses — list all status dirs
  router.get('/statuses', async (c) => {
    const statuses = await taskRepo.listStatuses()
    return c.json({ statuses })
  })

  // GET /api/tasks — list all tasks
  router.get('/', async (c) => {
    try {
      const tasks = await taskRepo.listAll()
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

      const parsedNumber =
        body.issueNumber ??
        (body.issueUrl
          ? Number(body.issueUrl.match(/\/issues\/(\d+)/)?.[1] ?? '') || undefined
          : undefined)

      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const datePart = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join('')
      const timePart = [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('')
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

      await taskRepo.save(task)
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
      const task = await taskRepo.getById(id)
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

  // GET /api/repos/lookup?url=...|path=... — projects that own this repo.
  router.get('/lookup', (c) => {
    const urlParam = c.req.query('url')
    const pathParam = c.req.query('path')
    if (!urlParam && !pathParam) {
      return c.json({ error: 'url or path query param required' }, 400)
    }

    let entries: ReturnType<typeof repoRepo.findByGithubRepo> = []
    if (urlParam) {
      const parsed = parseGithubUrl(urlParam)
      if (parsed) entries = repoRepo.findByGithubRepo(parsed.owner, parsed.repo)
    } else if (pathParam) {
      entries = repoRepo.findByPath(pathParam)
    }

    const projectIds = [...new Set(entries.map((e) => e.projectId))]
    const projects = projectIds.flatMap((id) => {
      const p = projectRepo.get(id)
      return p ? [{ id: p.id, name: p.name }] : []
    })
    return c.json({ projects })
  })

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

  // GET /api/repos/mappings?projectId=X — list repo mappings for a project.
  // When projectId is omitted we fall back to the default project so legacy
  // single-tenant callers keep working.
  router.get('/mappings', (c) => {
    const projectId = c.req.query('projectId') ?? projectRepo.getDefaultId()
    const mappings = repoRepo.listByProject(projectId)
    return c.json({ mappings })
  })

  // POST /api/repos/mappings — upsert a single repo mapping.
  // Body: { name, projectId?, path?, githubOwner?, githubRepo?, workflow?, description? }
  router.post('/mappings', async (c) => {
    try {
      const body = await c.req.json<{ name: string; projectId?: string } & RepoMappingEntry>()
      if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
      const projectId = body.projectId ?? projectRepo.getDefaultId()
      repoRepo.upsert({
        name: body.name.trim(),
        projectId,
        path: body.path,
        githubOwner: body.githubOwner,
        githubRepo: body.githubRepo,
        workflow: body.workflow,
        description: body.description,
      })
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: 'Invalid body' }, 400)
    }
  })

  // DELETE /api/repos/mappings/:name?projectId=X — remove a repo mapping.
  router.delete('/mappings/:name', (c) => {
    const name = c.req.param('name')
    const projectId = c.req.query('projectId') ?? projectRepo.getDefaultId()
    repoRepo.deleteByProject(name, projectId)
    return c.json({ ok: true })
  })

  // GET /api/repos/scan-roots — list user-defined scan roots
  router.get('/scan-roots', (c) => {
    return c.json({ scanRoots: settingsRepo.getScanRoots() })
  })

  // PUT /api/repos/scan-roots — replace scan roots list
  router.put('/scan-roots', async (c) => {
    try {
      const body = await c.req.json<{ scanRoots: string[] }>()
      if (!Array.isArray(body.scanRoots))
        return c.json({ error: 'scanRoots must be an array' }, 400)
      settingsRepo.setScanRoots(body.scanRoots)
      clearRepoCache()
      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'Invalid body' }, 400)
    }
  })

  return router
}
