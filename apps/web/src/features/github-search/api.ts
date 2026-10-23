import { z } from 'zod'
import { splitRef } from '@/features/github-search/query'

// «Buscar en GitHub» habla directo con api.github.com con el token del login de GitHub (sólo
// lectura): no pasa por el runner, así que no usa axios (sus `defaults` apuntan al runner y llevan
// su token). El `fetch` es inyectable para los tests.

const API = 'https://api.github.com'

/** Un issue o PR de GitHub, tal como lo muestra la búsqueda. */
export interface GithubIssue {
  /** `owner/repo#n` */
  ref: string
  title: string
  url: string
  open: boolean
  isPR: boolean
  updatedAt: string
}

/** GitHub contestó algo que no es 2xx: el status y su mensaje. */
export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const IssueBodySchema = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  updated_at: z.string(),
  repository_url: z.string(),
  pull_request: z.object({}).passthrough().nullish(),
})
type IssueBody = z.infer<typeof IssueBodySchema>

const SearchPageSchema = z.object({ items: z.array(IssueBodySchema) })
const ReposSchema = z.array(z.object({ name: z.string(), archived: z.boolean().optional() }))

function toIssue(body: IssueBody): GithubIssue | null {
  // https://api.github.com/repos/<owner>/<repo>
  const [owner, repo] = body.repository_url.split('/').slice(-2)
  if (!owner || !repo) return null
  return {
    ref: `${owner}/${repo}#${body.number}`,
    title: body.title,
    url: body.html_url,
    open: body.state === 'open',
    isPR: body.pull_request != null,
    updatedAt: body.updated_at,
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface GithubSearchApi {
  /** Issues por texto en el título (lo más reciente primero), en toda la org o en un repo. */
  search(text: string, org: string, repo: string | null): Promise<GithubIssue[]>
  /** Los repos de la org que ve el login, del de actividad más reciente al más viejo (hasta 300). */
  repos(org: string): Promise<string[]>
  /** Un issue o PR por su ref; `null` si no existe o el login no lo puede ver. */
  issue(ref: string): Promise<GithubIssue | null>
}

export function createGithubSearchApi(
  token: string,
  fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init),
): GithubSearchApi {
  async function get(url: string): Promise<unknown> {
    const res = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: unknown } | null
      const message =
        typeof body?.message === 'string' ? body.message : `GitHub: HTTP ${res.status}`
      throw new GithubApiError(res.status, message)
    }
    return res.json()
  }

  return {
    async search(text, org, repo) {
      const scope = repo ? `repo:${org}/${repo}` : `org:${org}`
      // GitHub exige `is:issue` o `is:pull-request` (no los dos): se buscan issues; un PR, por su ref.
      const q = `${text} ${scope} in:title is:issue`
      const params = new URLSearchParams({ q, sort: 'updated', per_page: '8' })
      const page = SearchPageSchema.parse(await get(`${API}/search/issues?${params}`))
      return page.items.map(toIssue).filter((i): i is GithubIssue => i !== null)
    },

    async repos(org) {
      const names: string[] = []
      for (let page = 1; page <= 3; page++) {
        const url = `${API}/orgs/${encodeURIComponent(org)}/repos?per_page=100&sort=pushed&page=${page}`
        const batch = ReposSchema.parse(await get(url))
        names.push(...batch.filter((r) => !r.archived).map((r) => r.name))
        if (batch.length < 100) break
      }
      return names
    },

    async issue(ref) {
      const parts = splitRef(ref)
      if (!parts) return null
      const url = `${API}/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/issues/${parts.number}`
      try {
        return toIssue(IssueBodySchema.parse(await get(url)))
      } catch (err) {
        if (err instanceof GithubApiError && err.status === 404) return null
        throw err
      }
    },
  }
}
