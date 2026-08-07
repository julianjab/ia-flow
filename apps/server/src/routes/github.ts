import { Hono } from 'hono'
import { rest } from '../github/client.js'
import {
  type ProjectField,
  getProjectMeta,
  listProjectItems,
  removeStatusOptions,
  setProjectTextField,
} from '../github/project.js'

interface CachedMeta {
  at: number
  data: { fields: Array<{ name: string; dataType: string; options: string[] }> }
}

let cache: CachedMeta | null = null
const TTL_MS = 5 * 60 * 1000

interface OwnersCache {
  at: number
  data: { owners: Array<{ login: string; type: 'user' | 'org' }> }
}
let ownersCache: OwnersCache | null = null

const reposCache = new Map<string, { at: number; data: { repos: string[] } }>()

export function createGithubRouter() {
  interface ItemsCachedData {
    at: number
    data: { items: import('../github/project.js').ProjectItem[] }
  }
  let itemsCache: ItemsCachedData | null = null
  const ITEMS_TTL_MS = 60 * 1000

  const router = new Hono()

  // GET /api/github/project-meta — expose fields + single-select options
  router.get('/project-meta', async (c) => {
    const url = Bun.env.GITHUB_PROJECT_URL
    if (!url) return c.json({ error: 'GITHUB_PROJECT_URL not set', fields: [] }, 200)

    const force = c.req.query('refresh') === '1'
    if (!force && cache && Date.now() - cache.at < TTL_MS) {
      return c.json(cache.data)
    }

    try {
      const meta = await getProjectMeta(url)
      const fields = Object.values(meta.fields).map((f: ProjectField) => ({
        name: f.name ?? '',
        dataType: f.dataType ?? '',
        options: (f.options ?? []).map((o) => o.name),
      }))
      cache = { at: Date.now(), data: { fields } }
      return c.json(cache.data)
    } catch (err) {
      return c.json({ error: (err as Error).message, fields: [] }, 502)
    }
  })

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

  // DELETE /api/github/status-options — remove obsolete options from the Status field
  // Body: { options: string[] }  e.g. { options: ["Refining", "Implementing", "Triaging"] }
  router.delete('/status-options', async (c) => {
    const url = Bun.env.GITHUB_PROJECT_URL
    if (!url) return c.json({ error: 'GITHUB_PROJECT_URL not set' }, 400)

    const body = (await c.req.json().catch(() => ({}))) as { options?: string[] }
    const toRemove: string[] = body.options ?? ['Refining', 'Implementing', 'Triaging']
    if (!toRemove.length) return c.json({ removed: [] })

    try {
      const meta = await getProjectMeta(url)
      cache = null // invalidate cache
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

  // GET /api/github/project-items — list project items
  router.get('/project-items', async (c) => {
    const url = Bun.env.GITHUB_PROJECT_URL
    if (!url) return c.json({ error: 'GITHUB_PROJECT_URL not set', items: [] }, 200)

    const force = c.req.query('refresh') === '1'
    if (!force && itemsCache && Date.now() - itemsCache.at < ITEMS_TTL_MS) {
      return c.json(itemsCache.data)
    }

    try {
      const meta = await getProjectMeta(url)
      const items = await listProjectItems(meta.projectId, meta.fields)
      itemsCache = { at: Date.now(), data: { items } }
      return c.json(itemsCache.data)
    } catch (err) {
      return c.json({ error: (err as Error).message, items: [] }, 502)
    }
  })

  // PATCH /api/github/project-items/:itemId/repos — update Repos field
  router.patch('/project-items/:itemId/repos', async (c) => {
    const url = Bun.env.GITHUB_PROJECT_URL
    if (!url) return c.json({ error: 'GITHUB_PROJECT_URL not set' }, 400)

    const itemId = c.req.param('itemId')
    const body = await c.req.json<{ repos: string[] }>().catch(() => null)
    if (!body || !Array.isArray(body.repos)) {
      return c.json({ error: 'repos must be an array' }, 400)
    }

    try {
      const meta = await getProjectMeta(url)
      const reposField = meta.fields['Repos']
      if (!reposField) return c.json({ error: 'Repos field not found in project' }, 404)

      const text = body.repos.join(', ')
      await setProjectTextField(meta.projectId, itemId, reposField, text)
      itemsCache = null // invalidate cache
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502)
    }
  })

  return router
}
