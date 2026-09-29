// `type`, no `interface` — ver la nota en CLAUDE.md sobre por qué (asignabilidad a
// `GithubWebhookEvent['payload']`, que resuelve a `Record<string, unknown>` por default).
export type GithubCheckPayload = {
  /** De qué evento de GitHub vino — los dos comparten forma acá, pero no son el mismo hecho. */
  kind: 'check_suite' | 'workflow_run'
  owner: string
  repo: string
  /** El workflow (`workflow_run`) o la App que corrió los checks (`check_suite`, sin nombre propio). */
  name: string
  /** `queued` | `in_progress` | `completed`. */
  status: string
  /** `success` | `failure` | `cancelled` | `timed_out` | … — vacío hasta que `status` es `completed`. */
  conclusion: string
  branch: string
  sha: string
  url: string
  /** Los PRs que GitHub asocia a la corrida — vacío para un push sin PR o un PR desde un fork. */
  prNumbers: number[]
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

/**
 * Extrae los campos de un payload de webhook `check_suite` o `workflow_run` (ya parseado). Los
 * dos se aplanan a la misma forma porque describen lo mismo —"terminó una corrida de CI sobre un
 * commit"— pero `kind` conserva cuál fue: fusionarlos en un solo nombre de evento es decisión de
 * la app, no de este paquete.
 */
export function parseGithubCheckPayload(
  kind: 'check_suite' | 'workflow_run',
  raw: Record<string, unknown>,
): GithubCheckPayload {
  const run = raw[kind] as Record<string, unknown>
  const repository = raw.repository as Record<string, unknown>
  const app = run.app as Record<string, unknown> | undefined
  const prs = Array.isArray(run.pull_requests) ? run.pull_requests : []
  return {
    kind,
    owner: str((repository.owner as Record<string, unknown> | undefined)?.login),
    repo: str(repository.name),
    name: str(run.name ?? app?.name),
    status: str(run.status),
    conclusion: str(run.conclusion),
    branch: str(run.head_branch),
    sha: str(run.head_sha),
    url: str(run.html_url ?? run.url),
    prNumbers: prs
      .map((pr) => (pr as Record<string, unknown>)?.number)
      .filter((n): n is number => typeof n === 'number'),
  }
}
