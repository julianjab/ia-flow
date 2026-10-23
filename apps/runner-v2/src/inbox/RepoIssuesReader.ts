/**
 * Los issues abiertos de un repo del catálogo (`projects[].repos`), sin PRs, el más reciente
 * primero: lo que la bandeja cruza con los boards para mostrar lo que todavía no tiene card. Con la
 * identidad del runner y un cache corto por repo, que un webhook `issues.*` de ese repo suelta.
 */
import type { GithubClient } from '@ia-flow/github-api'
import { memoize, type RepoIssues } from '@ia-flow/shared'

/** Un issue abierto de un repo, con lo que muestra la vista. */
export interface RepoIssueRow {
  /** `owner/repo#n`, con el owner y el repo como los escribe GitHub. */
  ref: string
  title: string
  url: string
  labels: string[]
  updatedAt: string
  author?: string
}

/** Lo que se leyó de un repo: sus issues abiertos (a lo sumo `MAX_PAGES` páginas), si quedaron
 *  más en GitHub, o por qué no se pudo leer. */
export interface RepoIssuesRead {
  issues: RepoIssueRow[]
  more: boolean
  error?: string
}

/** Cuánto vale lo leído de un repo sin un webhook que lo suelte. */
const TTL_MS = 60_000
/** Tope de issues sin card por repo (`GET /api/repos/issues`). */
const LIMIT = 100
const PER_PAGE = 100
/** Páginas por repo: lo que ya tiene card se descuenta después, y cada página trae también PRs. */
const MAX_PAGES = 3

interface RawIssue {
  number: number
  title: string
  html_url: string
  repository_url?: string
  updated_at: string
  user?: { login: string } | null
  labels?: Array<string | { name?: string }>
  pull_request?: unknown
}

/** `owner/repo` de la URL de la API del repo; si no viene, el del catálogo. */
function repoOf(raw: RawIssue, fallback: string): string {
  const m = /\/repos\/([^/]+\/[^/]+)$/.exec(raw.repository_url ?? '')
  return m?.[1] ?? fallback
}

/** Un issue de la REST de GitHub; un PR (la REST los lista como issues), `undefined`. */
export function toRepoIssue(raw: RawIssue, repo: string): RepoIssueRow | undefined {
  if (raw.pull_request) return undefined
  return {
    ref: `${repoOf(raw, repo)}#${raw.number}`,
    title: raw.title,
    url: raw.html_url,
    labels: (raw.labels ?? [])
      .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
      .filter((name) => name !== ''),
    updatedAt: raw.updated_at,
    ...(raw.user?.login ? { author: raw.user.login } : {}),
  }
}

/** La página siguiente del header `Link` de GitHub. */
export function nextLink(header: string | null): string | undefined {
  return header
    ?.split(',')
    .find((part) => /rel="next"/.test(part))
    ?.match(/<([^>]+)>/)?.[1]
}

/** Por qué no se pudo leer un repo, en una línea para una persona. */
export function readError(status: number): string {
  if (status === 404) return 'El repo no existe o el runner no tiene acceso'
  if (status === 403 || status === 401) return 'El runner no tiene permiso para leer sus issues'
  if (status === 410) return 'El repo tiene los issues desactivados'
  return `GitHub respondió ${status}`
}

/** El repo (`owner/repo`, en minúsculas) de un webhook `issues.*`; cualquier otro, `undefined`. */
export function issuesWebhookRepo(event: string, payload: Record<string, unknown>) {
  if (event !== 'issues') return undefined
  const repository = payload.repository as { full_name?: unknown } | undefined
  return typeof repository?.full_name === 'string' ? repository.full_name.toLowerCase() : undefined
}

/** Lo de un repo que muestra `GET /api/repos/issues`: sus issues sin card (`carded`, refs en
 *  minúsculas), el más reciente primero y hasta `LIMIT`; `truncated` si GitHub tenía más. */
export function withoutCards(
  entry: { repo: string; projectId: string },
  read: RepoIssuesRead,
  carded: Set<string>,
): RepoIssues['repos'][number] {
  const free = read.issues
    .filter((issue) => !carded.has(issue.ref.toLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const truncated = read.more || free.length > LIMIT
  return {
    repo: entry.repo,
    project_id: entry.projectId,
    items: free.slice(0, LIMIT).map((issue) => ({
      ref: issue.ref,
      project_id: entry.projectId,
      title: issue.title,
      url: issue.url,
      labels: issue.labels,
      updated_at: issue.updatedAt,
      ...(issue.author ? { author: issue.author } : {}),
    })),
    ...(truncated ? { truncated: true } : {}),
    ...(read.error ? { error: read.error } : {}),
  }
}

export class RepoIssuesReader {
  /** Sube con cada `invalidate` del repo: es parte de la clave del cache, así se suelta sólo ese. */
  private readonly generations = new Map<string, number>()

  constructor(private readonly client: GithubClient) {}

  /** Los issues abiertos de `owner/repo`, cacheados un minuto por repo. Nunca falla: un repo que
   *  no se puede leer trae su `error`. */
  issues(repo: string): Promise<RepoIssuesRead> {
    return this.cached(repo, this.generations.get(repo.toLowerCase()) ?? 0)
  }

  /** Un webhook `issues.*` del repo: lo próximo que se pida de él, se relee. */
  invalidate(repo: string): void {
    const key = repo.toLowerCase()
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
  }

  @memoize({
    ttlMs: TTL_MS,
    key: (repo: string, generation: number) => `${repo.toLowerCase()}@${generation}`,
  })
  private cached(repo: string, _generation: number): Promise<RepoIssuesRead> {
    return this.read(repo).catch((err: unknown) => ({
      issues: [],
      more: false,
      error: err instanceof Error ? err.message : String(err),
    }))
  }

  private async read(repo: string): Promise<RepoIssuesRead> {
    const issues: RepoIssueRow[] = []
    let path: string | undefined =
      `/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=${PER_PAGE}`
    for (let page = 0; page < MAX_PAGES && path; page++) {
      const res = await this.client.request(path)
      if (!res.ok) {
        // Un repo que sí se leyó a medias (falló una página siguiente) vale como truncado.
        if (page > 0) return { issues, more: true }
        return { issues: [], more: false, error: readError(res.status) }
      }
      for (const raw of (await res.json()) as RawIssue[]) {
        const issue = toRepoIssue(raw, repo)
        if (issue) issues.push(issue)
      }
      path = nextLink(res.headers.get('link'))
    }
    return { issues, more: path !== undefined }
  }
}
