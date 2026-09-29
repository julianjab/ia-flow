// `type`, no `interface` — ver la nota en CLAUDE.md sobre por qué (asignabilidad a
// `GithubWebhookEvent['payload']`, que resuelve a `Record<string, unknown>` por default).
export type GithubPullRequestPayload = {
  number: number
  title: string
  body: string
  owner: string
  repo: string
  /** `open` | `closed` — un PR mergeado también es `closed`; distinguirlo es `merged`. */
  state: string
  isDraft: boolean
  merged: boolean
  author: string
  headRef: string
  headSha: string
  baseRef: string
  url: string
  sender: string
}

export type GithubPullRequestReviewPayload = GithubPullRequestPayload & {
  /** `approved` | `changes_requested` | `commented` | `dismissed` — en minúsculas: GitHub lo
   *  manda en mayúsculas y un consumidor no debería tener que saberlo. */
  reviewState: string
  reviewer: string
  reviewBody: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function login(value: unknown): string {
  return str((value as Record<string, unknown> | undefined)?.login)
}

/**
 * Extrae los campos de un payload de webhook `pull_request` (ya parseado) — igual que
 * `parseGithubIssuePayload`, NO decide qué `action` importa: `opened`, `synchronize` o un
 * `closed` mergeado se distinguen del lado de la app (`raw.action` + `merged`).
 */
export function parseGithubPullRequestPayload(
  raw: Record<string, unknown>,
): GithubPullRequestPayload {
  const pr = raw.pull_request as Record<string, unknown>
  const repository = raw.repository as Record<string, unknown>
  const head = (pr.head ?? {}) as Record<string, unknown>
  const base = (pr.base ?? {}) as Record<string, unknown>
  return {
    number: Number(pr.number),
    title: str(pr.title),
    body: str(pr.body),
    owner: login(repository.owner),
    repo: str(repository.name),
    state: str(pr.state),
    isDraft: pr.draft === true,
    merged: pr.merged === true,
    author: login(pr.user),
    headRef: str(head.ref),
    headSha: str(head.sha),
    baseRef: str(base.ref),
    url: str(pr.html_url),
    sender: login(raw.sender),
  }
}

/** Igual que `parseGithubPullRequestPayload`, para un payload de webhook `pull_request_review`. */
export function parseGithubPullRequestReviewPayload(
  raw: Record<string, unknown>,
): GithubPullRequestReviewPayload {
  const review = raw.review as Record<string, unknown>
  return {
    ...parseGithubPullRequestPayload(raw),
    reviewState: str(review.state).toLowerCase(),
    reviewer: login(review.user),
    reviewBody: str(review.body),
  }
}
