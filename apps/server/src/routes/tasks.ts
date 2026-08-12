import type { RepoMappingEntry } from '@ia-flow/shared'
import { Hono } from 'hono'
import { getSourceForProjectId } from '../application/source-registry.js'
import { projectRepo, repoRepo, settingsRepo, taskRepo } from '../composition/container.js'
import { createLogger } from '../logger.js'
import type { CreateItemInput, UpdateItemInput } from '../project-sources/types.js'
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

  // POST /api/tasks — create a task in the project's provider
  router.post('/', async (c) => {
    let body: {
      projectId?: string
      title?: string
      description?: string
      type?: 'functional' | 'technical'
      repos?: string[]
      status?: string
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (!body.projectId) return c.json({ error: 'projectId is required' }, 400)
    if (!body.title) return c.json({ error: 'title is required' }, 400)
    if (!projectRepo.get(body.projectId)) {
      return c.json({ error: `Project '${body.projectId}' not found` }, 404)
    }

    let source: ReturnType<typeof getSourceForProjectId>
    try {
      source = getSourceForProjectId(body.projectId)
    } catch (err) {
      log.error({ err, projectId: body.projectId }, 'Failed to resolve source')
      return c.json({ error: (err as Error).message }, 500)
    }
    if (!source.createItem) {
      return c.json({ error: `Provider '${source.kind}' does not support creating tasks` }, 501)
    }

    const input: CreateItemInput = {
      title: body.title,
      ...(body.description !== undefined && { description: body.description }),
      ...(body.type !== undefined && { type: body.type }),
      ...(body.repos !== undefined && { repos: body.repos }),
      ...(body.status !== undefined && { status: body.status }),
    }

    try {
      const item = await source.createItem(input)
      broadcast({ type: 'task:created', projectId: body.projectId, item })
      return c.json({ item, projectId: body.projectId }, 201)
    } catch (err) {
      log.error({ err, projectId: body.projectId }, 'createItem failed')
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // PUT /api/tasks/:id — patch a task via its project's provider
  router.put('/:id', async (c) => {
    const id = c.req.param('id')
    let body: {
      projectId?: string
      title?: string
      description?: string
      type?: 'functional' | 'technical'
      repos?: string[]
      status?: string
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (!body.projectId) return c.json({ error: 'projectId is required' }, 400)
    if (!projectRepo.get(body.projectId)) {
      return c.json({ error: `Project '${body.projectId}' not found` }, 404)
    }

    let source: ReturnType<typeof getSourceForProjectId>
    try {
      source = getSourceForProjectId(body.projectId)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
    if (!source.updateItem) {
      return c.json({ error: `Provider '${source.kind}' does not support updating tasks` }, 501)
    }

    const patch: UpdateItemInput = {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.type !== undefined && { type: body.type }),
      ...(body.repos !== undefined && { repos: body.repos }),
      ...(body.status !== undefined && { status: body.status }),
    }

    try {
      const item = await source.updateItem(id, patch)
      broadcast({ type: 'task:updated', projectId: body.projectId, item })
      return c.json({ item, projectId: body.projectId })
    } catch (err) {
      log.error({ err, projectId: body.projectId, id }, 'updateItem failed')
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // DELETE /api/tasks/:id?projectId=... — delete a task via the project's provider
  router.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const projectId = c.req.query('projectId')
    if (!projectId) return c.json({ error: 'projectId query param is required' }, 400)
    if (!projectRepo.get(projectId)) {
      return c.json({ error: `Project '${projectId}' not found` }, 404)
    }

    let source: ReturnType<typeof getSourceForProjectId>
    try {
      source = getSourceForProjectId(projectId)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
    if (!source.deleteItem) {
      return c.json({ error: `Provider '${source.kind}' does not support deleting tasks` }, 501)
    }

    try {
      await source.deleteItem(id)
      broadcast({ type: 'task:deleted', projectId, id })
      return c.json({ ok: true })
    } catch (err) {
      log.error({ err, projectId, id }, 'deleteItem failed')
      return c.json({ error: (err as Error).message }, 500)
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
