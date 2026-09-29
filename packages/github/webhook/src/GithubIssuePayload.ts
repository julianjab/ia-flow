// `type`, no `interface` — ver la nota en CLAUDE.md sobre por qué (asignabilidad a
// `GithubWebhookEvent['payload']`, que resuelve a `Record<string, unknown>` por default).
export type GithubIssuePayload = {
  title: string
  body: string
  number: number
  owner: string
  repo: string
  labels: string[]
  sender: string
  /** `issues`/`issue_comment` también llegan para PRs (en la API de GitHub un PR ES un issue):
   *  `true` cuando este "issue" es en realidad un Pull Request. */
  isPullRequest: boolean
}

export type GithubIssueCommentPayload = GithubIssuePayload & {
  commentId: number
  commentBody: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
}

function issueLabels(issue: Record<string, unknown>): string[] {
  const labels = issue.labels
  if (!Array.isArray(labels)) return []
  return labels.map((label) => str((label as Record<string, unknown>)?.name))
}

/**
 * Extrae los campos de un payload de webhook `issues` (ya parseado) — NO decide qué `action`
 * importa ni qué `type` de evento le corresponde, eso es decisión de la app (ver
 * `GithubWebhookEvent.ts` y el README de este paquete). Función pura: mismo payload de entrada,
 * mismo resultado, sin I/O.
 */
export function parseGithubIssuePayload(raw: Record<string, unknown>): GithubIssuePayload {
  const issue = raw.issue as Record<string, unknown>
  const repository = raw.repository as Record<string, unknown>
  const owner = repository.owner as Record<string, unknown>
  const sender = raw.sender as Record<string, unknown> | undefined
  return {
    title: str(issue.title),
    body: str(issue.body),
    number: num(issue.number),
    owner: str(owner.login),
    repo: str(repository.name),
    labels: issueLabels(issue),
    sender: str(sender?.login),
    isPullRequest: issue.pull_request != null,
  }
}

/** Igual que `parseGithubIssuePayload`, para un payload de webhook `issue_comment`. */
export function parseGithubIssueCommentPayload(
  raw: Record<string, unknown>,
): GithubIssueCommentPayload {
  const comment = raw.comment as Record<string, unknown>
  return {
    ...parseGithubIssuePayload(raw),
    commentId: num(comment.id),
    commentBody: str(comment.body),
  }
}
