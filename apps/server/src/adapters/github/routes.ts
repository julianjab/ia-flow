import { Hono } from 'hono'
import { rest } from './api/client.js'
import { getProjectMeta, removeStatusOptions } from './api/project.js'
import { getRateLimit } from './api/rate-limit.js'

// Global (per-token, not per-project) GitHub endpoints. Per-project reads
// and writes for items/statuses live under /api/projects/:id/source/*.
//
// What used to be here and moved out:
//   · GET   /api/github/project-meta            → /api/projects/:id/source/statuses
//   · GET   /api/github/project-items           → /api/projects/:id/source/items
//   · PATCH /api/github/project-items/:id/repos → PATCH /api/projects/:id/source/items/:id/Repos

const TTL_MS = 5 * 60 * 1000

interface OwnersCache {
  at: number
  data: { owners: Array<{ login: string; type: 'user' | 'org' }> }
}
let ownersCache: OwnersCache | null = null

const reposCache = new Map<string, { at: number; data: { repos: string[] } }>()

export function createGithubRouter() {
  const router = new Hono()

  // GET /api/github/owners — viewer login + orgs the token has access to
  router.get('/owners', async (c) => {
    const force = c.req.query('refresh') === '1'
    if (!force && ownersCache && Date.now() - ownersCache.at < TTL_MS) {
      return c.json(ownersCache.data)
    }
    try {
      const me = (await rest('/user')) as { login: string }
      const orgs = (await rest('/user/orgs?per_page=100')) as Array<{ login: string }>
      const owners: Array<{ login: string; type: 'user' | 'org' }> = [
        { login: me.login, type: 'user' },
        ...orgs.map((o) => ({ login: o.login, type: 'org' as const })),
      ]
      ownersCache = { at: Date.now(), data: { owners } }
      return c.json(ownersCache.data)
    } catch (err) {
      return c.json({ error: (err as Error).message, owners: [] }, 502)
    }
  })

  // GET /api/github/repos?owner=X — repos accessible under owner
  router.get('/repos', async (c) => {
    const owner = c.req.query('owner')?.trim()
    if (!owner) return c.json({ error: 'owner query param required', repos: [] }, 400)

    const force = c.req.query('refresh') === '1'
    const cached = reposCache.get(owner)
    if (!force && cached && Date.now() - cached.at < TTL_MS) {
      return c.json(cached.data)
    }

    try {
      // Detect owner type. Try org first, fall back to user.
      let repos: string[] = []
      try {
        const orgRepos = (await rest(
          `/orgs/${encodeURIComponent(owner)}/repos?per_page=100&sort=pushed`,
        )) as Array<{ name: string }>
        repos = orgRepos.map((r) => r.name)
      } catch {
        const userRepos = (await rest(
          `/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=pushed`,
        )) as Array<{ name: string }>
        repos = userRepos.map((r) => r.name)
      }
      const data = { repos }
      reposCache.set(owner, { at: Date.now(), data })
      return c.json(data)
    } catch (err) {
      return c.json({ error: (err as Error).message, repos: [] }, 502)
    }
  })

  // DELETE /api/github/status-options — remove obsolete options from the Status
  // field of a specific project. Admin-only utility.
  // Query: ?projectId=X
  // Body:  { options: string[] }  e.g. { options: ["Refining", "Implementing"] }
  router.delete('/status-options', async (c) => {
    const projectId = c.req.query('projectId')
    if (!projectId) return c.json({ error: 'projectId query param required' }, 400)
    const { projectRepo } = await import('../../composition/container.js')
    const project = projectRepo.get(projectId)
    if (!project || project.source?.kind !== 'github') {
      return c.json({ error: "Project source is not 'github'" }, 400)
    }
    const url = project.source.config?.url
    if (typeof url !== 'string' || !url) {
      return c.json({ error: 'Project github source has no url configured' }, 400)
    }

    const body = (await c.req.json().catch(() => ({}))) as { options?: string[] }
    const toRemove: string[] = body.options ?? ['Refining', 'Implementing', 'Triaging']
    if (!toRemove.length) return c.json({ removed: [] })

    try {
      const meta = await getProjectMeta(url)
      const statusField = meta.fields['Status']
      if (!statusField) return c.json({ error: 'Status field not found in project' }, 404)

      const before = statusField.options?.map((o) => o.name) ?? []
      await removeStatusOptions(meta.projectId, statusField, toRemove)
      const after = (statusField.options ?? [])
        .filter((o) => !toRemove.map((n) => n.toLowerCase()).includes(o.name.toLowerCase()))
        .map((o) => o.name)

      return c.json({
        removed: toRemove.filter((n) =>
          before.map((b) => b.toLowerCase()).includes(n.toLowerCase()),
        ),
        remaining: after,
      })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502)
    }
  })

  // GET /api/github/rate-limit — current in-memory rate-limit snapshot. The
  // web polls this on load to render the banner without waiting for the next
  // WS event.
  router.get('/rate-limit', (c) => c.json(getRateLimit()))

  return router
}
