import { Hono } from 'hono'
import { rest } from '../github/client.js'
import { getProjectMeta, type ProjectField } from '../github/project.js'

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
        name: f.name,
        dataType: f.dataType,
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

  return router
}
