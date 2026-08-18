import type { Context } from 'hono'
import { Hono } from 'hono'
import { projectRepo, sourceFactory } from '../composition/container.js'

// Sub-router mounted at /api/projects/:id/source. Every endpoint resolves the
// project row → its ProjectSource, so callers never talk to a specific
// provider (github, linear, ...). Behaviour on projects with no configured
// source: 200 with an empty payload — the UI treats that the same as
// "provider not connected yet".

function withProject(c: Context) {
  const id = c.req.param('id') ?? ''
  const project = id ? projectRepo.get(id) : null
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
      const source = sourceFactory.get(project)
      if (!source.getHealth) {
        return c.json({ ok: true, kind: source.kind, missing: [], warnings: [] })
      }
      const health = await source.getHealth()
      return c.json({ kind: source.kind, ...health })
    } catch (err) {
      return c.json({ ok: false, missing: [], warnings: [], message: (err as Error).message }, 502)
    }
  })

  router.get('/fields', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found', fields: [] }, 404)
    const refresh = c.req.query('refresh') === '1'
    try {
      const source = sourceFactory.get(project)
      // Fallback for sources that don't implement getFields: expose a synthetic
      // Status field derived from getStatuses so the UI always has something.
      if (!source.getFields) {
        const statuses = await source.getStatuses({ refresh })
        return c.json({
          kind: source.kind,
          fields: [
            { name: 'Status', dataType: 'SINGLE_SELECT', options: statuses.map((s) => s.name) },
          ],
        })
      }
      const fields = await source.getFields({ refresh })
      return c.json({ kind: source.kind, fields })
    } catch (err) {
      return c.json({ error: (err as Error).message, fields: [] }, 502)
    }
  })

  router.get('/statuses', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found', statuses: [] }, 404)
    const refresh = c.req.query('refresh') === '1'
    try {
      const source = sourceFactory.get(project)
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
      const source = sourceFactory.get(project)
      const items = await source.getItems({ status, refresh })
      return c.json({ kind: source.kind, items })
    } catch (err) {
      return c.json({ error: (err as Error).message, items: [] }, 502)
    }
  })

  router.get('/items/:itemId/blockers', async (c) => {
    const { project } = withProject(c)
    if (!project) return c.json({ error: 'Project not found', blockers: [] }, 404)
    const itemId = c.req.param('itemId')
    try {
      const source = sourceFactory.get(project)
      if (!source.getBlockers) return c.json({ kind: source.kind, blockers: [] })
      let sourceItem = source.getItemById ? await source.getItemById(itemId) : null
      if (!sourceItem) {
        const items = await source.getItems()
        sourceItem = items.find((i) => i.id === itemId) ?? null
      }
      if (!sourceItem) return c.json({ error: 'Item not found', blockers: [] }, 404)
      // Convert SourceItem → IssueItem (matches PollingIssueManager.toIssueItem
      // enough for the blocker lookup; description is what the local source
      // needs, meta.issueNumber+repoName is what github needs).
      const issueItem = source.toIssueItem
        ? source.toIssueItem(sourceItem)
        : {
            id: sourceItem.id,
            title: sourceItem.title,
            description: (sourceItem.meta?.description as string) ?? '',
            type: (sourceItem.meta?.type as string) ?? '',
            repos: sourceItem.repos ? sourceItem.repos.split(',').map((r) => r.trim()) : [],
            status: sourceItem.status,
            meta: sourceItem.meta,
          }
      const blockers = await source.getBlockers(issueItem)
      return c.json({ kind: source.kind, blockers })
    } catch (err) {
      return c.json({ error: (err as Error).message, blockers: [] }, 502)
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
      const source = sourceFactory.get(project)
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
