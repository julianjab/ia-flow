// Interpreta lo que uno tiene a mano para identificar un repo de GitHub: la
// URL de la barra del navegador o el atajo `owner/repo`. Vive acá y no en una
// feature porque lo usan dos (`projects` para la fuente github-issues,
// `repos` para el mapeo de repos del proyecto) y features no se importan
// entre sí. Precedente del mismo tipo: composables/extractErrorMessage.ts.

export interface GithubRepoRef {
  owner: string
  repo: string
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

/**
 * Acepta `https://github.com/owner/repo` (con o sin esquema, con `/issues`,
 * `.git` o barra final) y el atajo `owner/repo`. Devuelve null para cualquier
 * otra cosa — incluido otro host: sin ese chequeo `gitlab.com/acme/api`
 * parsearía a owner `gitlab.com` / repo `acme` y se guardaría sin quejarse,
 * para fallar recién contra la API de GitHub.
 */
export function parseGithubRepoRef(raw: string): GithubRepoRef | null {
  const segments = pathSegments(raw)
  const [owner, repo] = segments ?? []
  if (!owner || !repo) return null
  return { owner, repo }
}

/**
 * El owner de lo que se está tipeando, aunque el repo todavía no esté
 * (`julianjab/`, `https://github.com/julianjab`). Sirve para pedir sus repos
 * y sugerirlos mientras se escribe, en vez de exigir elegir owner aparte.
 */
export function parseGithubOwner(raw: string): string {
  return pathSegments(raw)?.[0] ?? ''
}

/** Segmentos de path del ref, o null si el host no es GitHub. */
function pathSegments(raw: string): string[] | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const segments = trimmed
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
  // Un primer segmento con punto es un host, y sólo GitHub sirve acá.
  if (segments[0]?.includes('.')) {
    const host = segments.shift()?.toLowerCase()
    if (!host || !GITHUB_HOSTS.has(host)) return null
  }
  return segments
}

/** `owner/repo` — la forma corta que se muestra en un input de una sola línea. */
export function formatGithubRepoSlug(ref: Partial<GithubRepoRef>): string {
  return ref.owner && ref.repo ? `${ref.owner}/${ref.repo}` : ''
}

/** URL canónica del repo. Vacío si falta alguna de las dos mitades. */
export function formatGithubRepoUrl(ref: Partial<GithubRepoRef>): string {
  const slug = formatGithubRepoSlug(ref)
  return slug ? `https://github.com/${slug}` : ''
}
