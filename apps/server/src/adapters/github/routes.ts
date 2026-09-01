import {
  describeGitHubCredentials,
  getProjectMeta,
  getRateLimit,
  removeStatusOptions,
  rest,
} from '@ia-flow/issue-sources'
import { Hono } from 'hono'

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

/**
 * Una GitHub App NO es un usuario, y el descubrimiento de owners/repos tiene
 * que preguntar distinto según con qué identidad corre el daemon:
 *
 *   · PAT / `gh` → `/user` + `/user/orgs`: "¿quién soy y a qué orgs pertenezco?"
 *   · GitHub App → `/installation/repositories`: "¿a qué me dieron acceso?"
 *
 * `/user` con un installation token devuelve **403 Resource not accessible by
 * integration** — no es un permiso que falte, es un endpoint que no existe para
 * esa identidad. Sin esta rama, todo daemon en modo `github-app` mostraba el
 * autocomplete de repos en rojo y el operador tenía que tipear el slug entero.
 *
 * De paso la respuesta es más honesta: la App lista **exactamente** los repos a
 * los que la instalación llega, no todo lo que el owner tiene.
 */
function usesInstallationToken(): boolean {
  return describeGitHubCredentials()?.mode === 'github-app'
}

interface InstallationRepo {
  name: string
  owner: { login: string; type: string }
}

/** Los repos de la instalación, paginados. `per_page` es el máximo de la API;
 *  el tope de páginas es un freno contra un `total_count` que no baje nunca. */
async function listInstallationRepos(): Promise<InstallationRepo[]> {
  const out: InstallationRepo[] = []
  for (let page = 1; page <= 10; page++) {
    const res = (await rest(`/installation/repositories?per_page=100&page=${page}`)) as {
      total_count?: number
      repositories?: InstallationRepo[]
    }
    const batch = res.repositories ?? []
    out.push(...batch)
    if (batch.length < 100 || out.length >= (res.total_count ?? out.length)) break
  }
  return out
}

/** GitHub dice `Organization` / `User`; la web habla de `org` / `user`. */
function ownerType(type: string): 'user' | 'org' {
  return type === 'Organization' ? 'org' : 'user'
}

type Owner = { login: string; type: 'user' | 'org' }

/** Los owners que la instalación alcanza — deducidos de sus repos, deduplicados. */
async function ownersFromInstallation(): Promise<Owner[]> {
  const repos = await listInstallationRepos()
  const byLogin = new Map<string, Owner>()
  for (const r of repos) {
    byLogin.set(r.owner.login, { login: r.owner.login, type: ownerType(r.owner.type) })
  }
  return [...byLogin.values()]
}

/** El viewer del token y sus orgs. Sólo para identidades de usuario (PAT / `gh`). */
async function ownersFromViewer(): Promise<Owner[]> {
  const me = (await rest('/user')) as { login: string }
  const orgs = (await rest('/user/orgs?per_page=100')) as Array<{ login: string }>
  return [
    { login: me.login, type: 'user' },
    ...orgs.map((o) => ({ login: o.login, type: 'org' as const })),
  ]
}

export function createGithubRouter() {
  const router = new Hono()

  // GET /api/github/owners — viewer login + orgs the token has access to
  router.get('/owners', async (c) => {
    const force = c.req.query('refresh') === '1'
    if (!force && ownersCache && Date.now() - ownersCache.at < TTL_MS) {
      return c.json(ownersCache.data)
    }
    try {
      const owners = usesInstallationToken()
        ? await ownersFromInstallation()
        : await ownersFromViewer()
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
      let repos: string[] = []
      if (usesInstallationToken()) {
        // La instalación ya sabe a qué llega: filtrar su lista evita pegarle a
        // `/orgs/:owner/repos`, que devolvería repos que el token no puede leer.
        repos = (await listInstallationRepos())
          .filter((r) => r.owner.login.toLowerCase() === owner.toLowerCase())
          .map((r) => r.name)
        const data = { repos }
        reposCache.set(owner, { at: Date.now(), data })
        return c.json(data)
      }
      // Identidad de usuario: no sabemos si el owner es org o persona. Probamos
      // org primero y caemos a user.
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
    // Las dos grafías: 'github-projects' es la canónica, 'github' el alias
    // deprecado que siguen teniendo las filas viejas (ver createDefaultSourceFactory).
    const kind = project?.source?.kind
    if (!project || (kind !== 'github-projects' && kind !== 'github')) {
      return c.json({ error: "Project source is not 'github-projects'" }, 400)
    }
    // `kind` ya probó que `project.source` existe, pero el narrowing se pierde
    // al leerlo en una variable aparte — de ahí el acceso opcional.
    const url = project.source?.config?.url
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
