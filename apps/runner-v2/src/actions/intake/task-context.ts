/**
 * El contexto de una task que los prompts leen además del issue: `{{task.comments}}` (el timeline
 * del issue y de su PR), `{{task.ci}}` y `{{task.pr.*}}`. Mismas formas que las variables de
 * ia-flow (`apps/server/src/variables/task.ts`), para que los prompts no cambien — con una
 * mejora: cada review thread sin resolver lleva su `thread <id>` en la cabecera, que es lo que
 * `reply_pr_review_thread`/`resolve_pr_review_thread` necesitan (ia-flow lo tiene en el objeto
 * pero no lo imprime, así que el agente no lo ve). También carga los blockers abiertos del issue,
 * que es lo que lee el gate de `allowBlocked`.
 *
 * Lo carga cada Action de resolución antes de emitir, así que cualquier agente —el reviewer que
 * arranca con un PR recién abierto, el implementer que atiende un comentario— lo recibe igual.
 */
import type { GithubClient } from '@ia-tools/github-api'

export interface TaskContext {
  /** Comentarios del issue y del PR, en orden, con `[fecha · origen · autor]` por bloque. */
  comments: string
  /** `success` | `failure` | `pending` del último commit del PR; vacío sin PR o sin checks. */
  ci: string
  /** El PR abierto de la task, si hay. */
  pr?: { number: number; url: string }
  /** Issues ABIERTOS que bloquean a éste (`mark_blocked_by`). Vacío = nada lo frena. */
  blockers: Array<{ number: number; title: string; url: string }>
}

export interface TaskContextQuery {
  owner: string
  repo: string
  /** El issue de la task. */
  number: number
  /** El PR, si el evento ya lo trae; si no, se busca el abierto desde `branch`. */
  pr?: number
  /** La rama de la task (`<branchPrefix><número>`). */
  branch: string
}

/** El puerto que usan las Actions — una interfaz para testearlas sin GitHub. */
export interface TaskContextReader {
  load(query: TaskContextQuery): Promise<TaskContext>
}

interface Comment {
  createdAt: string
  origin: string
  author?: string
  body: string
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Mismo formato que `formatComments` de ia-flow: el origen distingue "cambió el alcance"
 *  (issue) de "hay un problema con este código" (PR), y una review lleva `path:línea`. */
export function formatComments(comments: Comment[]): string {
  return [...comments]
    .filter((c) => c.body.trim())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => {
      const author = c.author ? ` · ${c.author}` : ''
      return `[${formatDate(c.createdAt)} · ${c.origin}${author}]\n${c.body.trim()}`
    })
    .join('\n\n')
}

/** Checks + statuses del commit → un solo estado, con el criterio de un `statusCheckRollup`:
 *  cualquier rojo gana, después cualquier pendiente; sin nada, vacío. */
export function rollupCi(
  checkRuns: Array<{ status: string; conclusion: string | null }>,
  statuses: string[],
): string {
  const states = [
    ...checkRuns.map((run) =>
      run.status !== 'completed'
        ? 'pending'
        : ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(
              run.conclusion ?? '',
            )
          ? 'failure'
          : 'success',
    ),
    ...statuses.map((state) => (state === 'error' ? 'failure' : state)),
  ]
  if (states.length === 0) return ''
  if (states.includes('failure')) return 'failure'
  if (states.includes('pending')) return 'pending'
  return 'success'
}

type User = { login?: string } | null

const REVIEW_THREADS = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(last: 30) {
        nodes {
          id isResolved path line
          comments(first: 20) { nodes { body createdAt author { login } } }
        }
      }
    }
  }
}`

interface ReviewThreadsData {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        nodes?: Array<{
          id: string
          isResolved: boolean
          path?: string | null
          line?: number | null
          comments?: { nodes?: Array<{ body?: string | null; createdAt: string; author?: User }> }
        }>
      }
    } | null
  } | null
}

/**
 * Un bloque por hilo SIN resolver — el hilo entero (pedido + respuestas), fechado por su último
 * mensaje. Un hilo resuelto no aparece: resolverlo es la forma de decir "atendido" (igual que en
 * ia-flow). La cabecera lleva el `thread <id>` para responderlo o resolverlo.
 */
function unresolvedThreads(data: ReviewThreadsData, label: string): Comment[] {
  const nodes = data.repository?.pullRequest?.reviewThreads?.nodes ?? []
  return nodes.flatMap((thread) => {
    const messages = (thread.comments?.nodes ?? []).filter((c) => c.body?.trim())
    const last = messages[messages.length - 1]
    if (thread.isResolved || !last) return []
    const where = thread.path
      ? ` · ${thread.path}${thread.line != null ? `:${thread.line}` : ''}`
      : ''
    return [
      {
        createdAt: last.createdAt,
        origin: `${label} · review${where} · thread ${thread.id}`,
        author: messages[0]?.author?.login,
        body: messages
          .map((c) => `**${c.author?.login ?? 'alguien'}:** ${c.body?.trim()}`)
          .join('\n\n'),
      },
    ]
  })
}
type RawComment = { body?: string | null; created_at: string; user?: User }

export class GithubTaskContextReader implements TaskContextReader {
  constructor(private readonly client: GithubClient) {}

  async load(query: TaskContextQuery): Promise<TaskContext> {
    const { owner, repo, number } = query
    const base = `/repos/${owner}/${repo}`
    const issueComments = await this.client.requestJson<RawComment[]>(
      `${base}/issues/${number}/comments?per_page=100`,
    )
    const comments: Comment[] = issueComments.map((c) => ({
      createdAt: c.created_at,
      origin: 'issue',
      author: c.user?.login,
      body: c.body ?? '',
    }))

    const blockers = await this.openBlockers(base, number)
    const pr = await this.openPullRequest(base, owner, query)
    if (!pr) return { comments: formatComments(comments), ci: '', blockers }

    const label = `PR #${pr.number}`
    const [prComments, threads, reviews, checks, status] = await Promise.all([
      this.client.requestJson<RawComment[]>(`${base}/issues/${pr.number}/comments?per_page=100`),
      this.client.graphql<ReviewThreadsData>(REVIEW_THREADS, { owner, repo, number: pr.number }),
      this.client.requestJson<
        Array<{ body?: string | null; submitted_at?: string; user?: User; state: string }>
      >(`${base}/pulls/${pr.number}/reviews?per_page=100`),
      this.client.requestJson<{ check_runs: Array<{ status: string; conclusion: string | null }> }>(
        `${base}/commits/${pr.headSha}/check-runs?per_page=100`,
      ),
      this.client.requestJson<{ statuses: Array<{ state: string }> }>(
        `${base}/commits/${pr.headSha}/status`,
      ),
    ])
    comments.push(
      ...prComments.map((c) => ({
        createdAt: c.created_at,
        origin: label,
        author: c.user?.login,
        body: c.body ?? '',
      })),
      ...unresolvedThreads(threads, label),
      ...reviews
        .filter((r) => r.submitted_at)
        .map((r) => ({
          createdAt: r.submitted_at as string,
          origin: `${label} · review · ${r.state.toLowerCase()}`,
          author: r.user?.login,
          body: r.body ?? '',
        })),
    )
    return {
      comments: formatComments(comments),
      ci: rollupCi(
        checks.check_runs,
        status.statuses.map((s) => s.state),
      ),
      pr: { number: pr.number, url: pr.url },
      blockers,
    }
  }

  /** Los issues abiertos que bloquean a `number` — la dependencia nativa de GitHub. */
  private async openBlockers(base: string, number: number) {
    const blockedBy = await this.client.requestJson<
      Array<{ number: number; title: string; state: string; html_url: string }>
    >(`${base}/issues/${number}/dependencies/blocked_by`)
    return blockedBy
      .filter((issue) => issue.state === 'open')
      .map((issue) => ({ number: issue.number, title: issue.title, url: issue.html_url }))
  }

  /** El PR del evento, o el abierto desde la rama de la task. */
  private async openPullRequest(base: string, owner: string, query: TaskContextQuery) {
    type Pr = { number: number; html_url: string; state: string; head: { sha: string } }
    const toRef = (pr: Pr) => ({ number: pr.number, url: pr.html_url, headSha: pr.head.sha })
    if (query.pr !== undefined) {
      const pr = await this.client.requestJson<Pr>(`${base}/pulls/${query.pr}`)
      return pr.state === 'open' ? toRef(pr) : undefined
    }
    const open = await this.client.requestJson<Pr[]>(
      `${base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${query.branch}`)}`,
    )
    return open[0] ? toRef(open[0]) : undefined
  }
}
