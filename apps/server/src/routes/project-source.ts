import type { Context } from 'hono'
import { Hono } from 'hono'
import { getDbProject } from '../db.js'
import { getSourceForProject } from '../project-sources/registry.js'

// Sub-router mounted at /api/projects/:id/source. Every endpoint resolves the
// project row → its ProjectSource, so callers never talk to a specific
// provider (github, linear, ...). Behaviour on projects with no configured
// source: 200 with an empty payload — the UI treats that the same as
// "provider not connected yet".

function withProject(c: Context) {
  const id = c.req.param('id')
  const project = getDbProject(id)
  return { id, project }
}

export function createProjectSourceRouter() {
  const router = new Hono()

  // Diagnostic: is the project's source correctly configured for the daemon?
  // Returns { ok, missing[], warnings[], message? } — see ProjectSource.getHealth.
  router.get('/health', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found', ok: false }, 404)
    try {
      const source = getSourceForProject(project)
      if (!source.getHealth) {
        return c.json({ ok: true, kind: source.kind, missing: [], warnings: [] })
      }
      const health = await source.getHealth()
      return c.json({ kind: source.kind, ...health })
    } catch (err) {
      return c.json({ ok: false, missing: [], warnings: [], message: (err as Error).message }, 502)
    }
  })

  router.get('/statuses', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found', statuses: [] }, 404)
    const refresh = c.req.query('refresh') === '1'
    try {
      const source = getSourceForProject(project)
      const statuses = await source.getStatuses({ refresh })
      return c.json({ kind: source.kind, statuses })
    } catch (err) {
      return c.json({ error: (err as Error).message, statuses: [] }, 502)
    }
  })

  router.get('/items', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found', items: [] }, 404)
    const refresh = c.req.query('refresh') === '1'
    const status = c.req.query('status') ?? undefined
    try {
      const source = getSourceForProject(project)
      const items = await source.getItems({ status, refresh })
      return c.json({ kind: source.kind, items })
    } catch (err) {
      return c.json({ error: (err as Error).message, items: [] }, 502)
    }
  })

  router.patch('/items/:itemId/:field', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const itemId = c.req.param('itemId')
    const field = c.req.param('field')
    const body = await c.req.json<{ value: unknown }>().catch(() => null)
    if (!body || typeof body.value !== 'string') {
      return c.json({ error: 'body.value (string) required' }, 400)
    }
    try {
      const source = getSourceForProject(project)
      if (!source.setItemField) {
        return c.json({ error: `Source '${source.kind}' does not support field updates` }, 501)
      }
      await source.setItemField(itemId, field, body.value)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502)
    }
  })

  return router
}
