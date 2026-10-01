/** Forma común de un issue tal como lo devuelve la REST API — la comparten `getIssue.ts` y
 *  `searchIssues.ts`. */
export interface GithubIssueApiShape {
  number: number
  title: string
  body: string | null
  state: string
  html_url: string
  labels: Array<{ name: string } | string>
}

export function summarizeIssue(issue: GithubIssueApiShape): string {
  const labels = issue.labels.map((label) => (typeof label === 'string' ? label : label.name))
  return JSON.stringify({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels,
    url: issue.html_url,
  })
}

// Nombres de owner/repo de GitHub: alfanumérico + `.`/`-`/`_`, nunca arrancan con esos tres.
// Sin esto, `owner`/`repo` —que vienen del MODELO, no de un caller de confianza— podían llevar
// un `../../orgs/otra-org/...` y hacer que `fetch` resuelva el path fuera de `/repos/o/r/...`,
// pegándole con el mismo token a un endpoint que el caller nunca pidió.
const SAFE_REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

function assertSafeSegment(label: string, value: string): string {
  if (!SAFE_REPO_SEGMENT.test(value)) {
    throw new Error(`GithubTools: "${label}" inválido: "${value}"`)
  }
  return encodeURIComponent(value)
}

function assertIssueNumber(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`GithubTools: "number" tiene que ser un entero positivo, vino "${value}"`)
  }
  return value
}

/** Arma `/repos/{owner}/{repo}` (+ `suffix`), validando y encodeando owner y repo. */
export function repoPath(owner: string, repo: string, suffix = ''): string {
  return `/repos/${assertSafeSegment('owner', owner)}/${assertSafeSegment('repo', repo)}${suffix}`
}

/** Arma `/repos/{owner}/{repo}/issues/{number}` (+ `suffix`), validando y encodeando cada
 *  segmento — el único lugar que construye estos paths, para que ninguna tool nueva se olvide. */
export function issuePath(owner: string, repo: string, number: number, suffix = ''): string {
  const safeOwner = assertSafeSegment('owner', owner)
  const safeRepo = assertSafeSegment('repo', repo)
  const safeNumber = assertIssueNumber(number)
  return `/repos/${safeOwner}/${safeRepo}/issues/${safeNumber}${suffix}`
}
