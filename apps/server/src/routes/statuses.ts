import { StatusConfigSchema, invalidateMemoized } from '@ia-flow/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { configRepo, projectRepo, statusRepo } from '../composition/container.js'

// See the matching comment in agents-crud.ts — configRepo.getConfig is
// memoized and shared with GET /api/project-config.
function invalidateConfigCache(): void {
  invalidateMemoized(configRepo, 'getConfig')
}

// Granular CRUD for status configs. Statuses are always project-scoped, so
// projectId is required on every write.
function resolveProject(
  c: Context,
): { ok: true; projectId: string } | { ok: false; error: string } {
  const projectId = c.req.query('projectId')
  if (!projectId) return { ok: false, error: 'projectId query param required' }
  if (!projectRepo.get(projectId)) return { ok: false, error: `Project ${projectId} not found` }
  return { ok: true, projectId }
}

export function createStatusesRouter() {
  const router = new Hono()

  router.get('/', (c) => {
    const s = resolveProject(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    return c.json({ statuses: statusRepo.list(s.projectId) })
  })

  router.post('/', async (c) => {
    const s = resolveProject(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    try {
      const parsed = StatusConfigSchema.parse(await c.req.json())
      if (statusRepo.getByName(s.projectId, parsed.name))
        return c.json({ error: `Status '${parsed.name}' already exists in this project` }, 409)
      const position = statusRepo.list(s.projectId).length
      statusRepo.upsert({ ...parsed, projectId: s.projectId }, position, s.projectId)
      invalidateConfigCache()
      return c.json({ status: { ...parsed, projectId: s.projectId } }, 201)
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  router.put('/:name', async (c) => {
    const s = resolveProject(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    const name = c.req.param('name')
    const list = statusRepo.list(s.projectId)
    const idx = list.findIndex((st) => st.name === name)
    if (idx < 0) return c.json({ error: `Status '${name}' not found in this project` }, 404)
    try {
      const parsed = StatusConfigSchema.parse(await c.req.json())
      if (parsed.name !== name) return c.json({ error: 'Body name does not match URL name' }, 400)
      statusRepo.upsert({ ...parsed, projectId: s.projectId }, idx, s.projectId)
      invalidateConfigCache()
      return c.json({ status: { ...parsed, projectId: s.projectId } })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  router.delete('/:name', (c) => {
    const s = resolveProject(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    const name = c.req.param('name')
    if (!statusRepo.getByName(s.projectId, name))
      return c.json({ error: `Status '${name}' not found in this project` }, 404)
    statusRepo.deleteByName(s.projectId, name)
    invalidateConfigCache()
    return c.json({ ok: true })
  })

  return router
}
