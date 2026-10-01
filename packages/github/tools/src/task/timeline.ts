/**
 * El contexto de una task que los prompts leen además del issue: `{{task.comments}}` (el timeline
 * del issue y de su PR) y `{{task.ci}}`. Cada review thread sin resolver lleva su `thread <id>` en
 * la cabecera, que es lo que `reply_pr_review_thread`/`resolve_pr_review_thread` necesitan.
 *
 * Puro: las respuestas de GitHub las lee el intake (`.config/.../intake/resolve-task.yaml`).
 */

interface Comment {
  createdAt: string
  origin: string
  author?: string
  body: string
}

type User = { login?: string } | null | undefined

/** Un comentario del issue o del PR, como lo devuelve `GET /issues/{n}/comments`. */
export type RawComment = { body?: string | null; created_at: string; user?: User }

/** Una review, como la devuelve `GET /pulls/{n}/reviews`. */
export type RawReview = { body?: string | null; submitted_at?: string; user?: User; state: string }

/** Un review thread, como lo devuelve `pullRequest.reviewThreads.nodes` por GraphQL. */
export interface RawThread {
  id: string
  isResolved: boolean
  path?: string | null
  line?: number | null
  comments?: { nodes?: Array<{ body?: string | null; createdAt: string; author?: User }> }
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
 *  cualquier rojo gana, después cualquier pendiente; sin nada, vacío.
 *
 *  Los workflow runs sólo suman pendientes: uno en cola (esperando runner, o un `needs`) todavía
 *  no creó sus check-runs, y sin él el rollup daba verde con los checks rápidos ya terminados.
 *  Uno terminado ya está en sus check-runs, con su conclusión. */
export function rollupCi(
  checkRuns: Array<{ status: string; conclusion: string | null }>,
  statuses: string[],
  workflowRuns: Array<{ status: string }> = [],
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
    ...workflowRuns.filter((run) => run.status !== 'completed').map(() => 'pending'),
  ]
  if (states.length === 0) return ''
  if (states.includes('failure')) return 'failure'
  if (states.includes('pending')) return 'pending'
  return 'success'
}

/**
 * Un bloque por hilo SIN resolver — el hilo entero (pedido + respuestas), fechado por su último
 * mensaje. Un hilo resuelto no aparece: resolverlo es la forma de decir "atendido" (igual que en
 * ia-flow). La cabecera lleva el `thread <id>` para responderlo o resolverlo.
 */
function unresolvedThreads(threads: RawThread[], label: string): Comment[] {
  return threads.flatMap((thread) => {
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

const fromRaw = (origin: string) => (c: RawComment) => ({
  createdAt: c.created_at,
  origin,
  author: c.user?.login ?? undefined,
  body: c.body ?? '',
})

/** El timeline de la task: los comentarios del issue y, con PR abierto, los del PR, sus hilos
 *  sin resolver y sus reviews. */
export function taskTimeline(input: {
  issueComments?: RawComment[]
  pr?: number
  prComments?: RawComment[]
  threads?: RawThread[]
  reviews?: RawReview[]
}): string {
  const comments: Comment[] = (input.issueComments ?? []).map(fromRaw('issue'))
  if (input.pr !== undefined) {
    const label = `PR #${input.pr}`
    comments.push(
      ...(input.prComments ?? []).map(fromRaw(label)),
      ...unresolvedThreads(input.threads ?? [], label),
      ...(input.reviews ?? [])
        .filter((r) => r.submitted_at)
        .map((r) => ({
          createdAt: r.submitted_at as string,
          origin: `${label} · review · ${r.state.toLowerCase()}`,
          author: r.user?.login ?? undefined,
          body: r.body ?? '',
        })),
    )
  }
  return formatComments(comments)
}
