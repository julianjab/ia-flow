import type { CreateItemInput, UpdateItemInput } from '@ia-flow/issue-sources'
import type { RepoMappingEntry } from '@ia-flow/shared'
import { SlackMemberRefSchema, SlackReviewMessageSchema, invalidateMemoized } from '@ia-flow/shared'
import { SlackReviewError } from '@ia-flow/slack'
import { Hono } from 'hono'
import { RunTaskNowError } from '../application/use-cases/RunTaskNowUseCase.js'
import {
  configRepo,
  enqueueRunMessageUseCase,
  getSourceForProjectId,
  projectRepo,
  repoRepo,
  runMessageRepo,
  runTaskNowUseCase,
  settingsRepo,
  slack,
  taskRepo,
} from '../composition/container.js'
import { createLogger } from '../logger.js'
import { clearRepoCache, listRepos } from '../repos.js'

// See the matching comment in agents-crud.ts — configRepo.getConfig is
// memoized and shared with GET /api/project-config.
function invalidateConfigCache(): void {
  invalidateMemoized(configRepo, 'getConfig')
}

const log = createLogger('tasks')

type BroadcastFn = (msg: object) => void

export interface CreateTaskBody {
  projectId?: string
  title?: string
  description?: string
  type?: 'functional' | 'technical'
  repos?: string[]
  status?: string
  draft?: boolean
}

// Pure — kept separate from the route handler (and its `title` presence
// check) so the optional-field wiring can be unit tested without importing
// composition/container.js, which opens a real SQLite connection as a
// side effect of module load (see routes/test/agents-crud.test.ts).
export function buildCreateItemInput(body: CreateTaskBody & { title: string }): CreateItemInput {
  return {
    title: body.title,
    ...(body.description !== undefined && { description: body.description }),
    ...(body.type !== undefined && { type: body.type }),
    ...(body.repos !== undefined && { repos: body.repos }),
    ...(body.status !== undefined && { status: body.status }),
    ...(body.draft !== undefined && { draft: body.draft }),
  }
}

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
    let body: CreateTaskBody
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

    const input = buildCreateItemInput({ ...body, title: body.title })

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

  // POST /api/tasks/:id/messages  { body, author?, source? }
  //
  // Inyecta un mensaje en el run de esta tarea. El loop lo drena al tope del
  // próximo turno, así que dirigir un agente en vuelo no requiere cortarlo.
  //
  // Se acepta aunque NO haya un run corriendo: el mensaje queda pendiente y lo
  // lee el próximo. Rechazarlo obligaría a quien escribe en el hilo a saber si
  // el agente está despierto, que es exactamente lo que no puede saber.
  router.post('/:id/messages', async (c) => {
    const taskId = c.req.param('id')
    let body: { body?: string; author?: string; source?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    const text = (body.body ?? '').trim()
    if (!text) return c.json({ error: '`body` es obligatorio' }, 400)

    const message = await enqueueRunMessageUseCase.execute({
      taskId,
      body: text,
      author: body.author,
      source: body.source,
    })

    return c.json({ message }, 201)
  })

  // GET /api/tasks/:id/messages — los pendientes, para que la UI muestre que
  // hay algo encolado que el agente todavía no leyó.
  router.get('/:id/messages', async (c) => {
    return c.json({ messages: await runMessageRepo.pending(c.req.param('id')) })
  })

  // POST /api/tasks/:id/slack-review  { projectId, allowFailedCi? }
  // Pide review del PR de esta tarea en Slack. El 400 lleva el motivo tal cual
  // (sin PR, CI corriendo, sin reviewers) — es lo que la tarjeta muestra.
  router.post('/:id/slack-review', async (c) => {
    const taskId = c.req.param('id')
    let body: { projectId?: string; allowFailedCi?: boolean }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (!body.projectId) return c.json({ error: 'projectId is required' }, 400)

    let source: ReturnType<typeof getSourceForProjectId>
    try {
      source = getSourceForProjectId(body.projectId)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }

    try {
      const result = await slack.reviewUseCase.execute(
        { projectId: body.projectId, taskId, allowFailedCi: body.allowFailedCi },
        source,
      )
      broadcast({ type: 'task:slack-review', projectId: body.projectId, id: taskId, result })
      return c.json(result)
    } catch (err) {
      if (err instanceof SlackReviewError) return c.json({ error: err.message }, 400)
      log.error({ err, taskId }, 'slack review failed')
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // POST /api/tasks/:id/run  { projectId }
  // Re-emite el status actual de la tarea para que las reglas la vuelvan a
  // evaluar, sin tocar el board. El 400 lleva el motivo tal cual — es lo que
  // muestra la tarjeta.
  router.post('/:id/run', async (c) => {
    const taskId = c.req.param('id')
    let body: { projectId?: string }
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

    try {
      const result = await runTaskNowUseCase.execute({ taskId, projectId: body.projectId }, source)
      broadcast({ type: 'task:run-requested', projectId: body.projectId, id: taskId, result })
      return c.json(result)
    } catch (err) {
      if (err instanceof RunTaskNowError) return c.json({ error: err.message }, 400)
      log.error({ err, taskId }, 'run-now failed')
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // GET /api/tasks/:id/run-preview?projectId=…
  // Qué pasaría si la corrieras: qué regla la toma, y si ninguna, POR QUÉ.
  // Es de lectura y no publica nada — el gemelo diagnóstico del POST de
  // arriba, y la única forma de ver "Rules NOT matched" sin leer el daemon.log.
  router.get('/:id/run-preview', async (c) => {
    const taskId = c.req.param('id')
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

    try {
      return c.json(await runTaskNowUseCase.preview({ taskId, projectId }, source))
    } catch (err) {
      if (err instanceof RunTaskNowError) return c.json({ error: err.message }, 400)
      log.error({ err, taskId }, 'run-preview failed')
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
      // Valida en el borde sólo lo que tiene forma propia: un reviewer mal
      // armado guardado como JSON sería ilegible recién al pedir el review.
      const reviewers = SlackMemberRefSchema.array().optional().safeParse(body.slackReviewers)
      if (!reviewers.success) return c.json({ error: 'slackReviewers inválido' }, 400)
      const messages = SlackReviewMessageSchema.optional().safeParse(body.slackReviewMessage)
      if (!messages.success) return c.json({ error: 'slackReviewMessage inválido' }, 400)
      const projectId = body.projectId ?? projectRepo.getDefaultId()
      repoRepo.upsert({
        name: body.name.trim(),
        projectId,
        path: body.path,
        githubOwner: body.githubOwner,
        githubRepo: body.githubRepo,
        workflow: body.workflow,
        description: body.description,
        slackReviewChannel: body.slackReviewChannel,
        slackReviewers: reviewers.data,
        slackReviewMessage: messages.data,
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
      invalidateConfigCache()
      clearRepoCache()
      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'Invalid body' }, 400)
    }
  })

  return router
}
