// La conversación de una task: los comentarios del issue MÁS los de sus PRs
// abiertos (pestaña Conversation) MÁS sus review threads sin resolver.
//
// ## Por qué existe
//
// Un agente que despierta pregunta "¿qué pasó desde mi última corrida?", y
// hasta acá esa pregunta sólo se contestaba con el issue. Pero el pipeline
// deja la mitad de sus hallazgos en el PR: el reporte de CI, el bug de
// runtime, y sobre todo la review humana — que era un canal COMPLETAMENTE
// muerto (nadie la leía nunca, aunque el MCP de GitHub tuviera las tools para
// hacerlo).
//
// ## Por qué es una sola query
//
// En la API v4 un PullRequest expone `comments` igual que un Issue, así que
// traer los dos es `nodes(ids: [issueId, ...prIds])` — un request, no uno por
// subject. Los node ids de los PRs ya vienen gratis en `meta.pullRequests`
// (ver `issueDevLinksSelection`), así que esto NO agrega round-trips al
// dispatch: es la misma llamada que ya se hacía, con más ids adentro.
//
// ## Por qué las review threads no se marcan como "usadas"
//
// Un comentario del issue se consume una vez y se marca (`markCommentsUsed`
// le anexa un marker al body). Una review thread NO: su señal de "ya está
// atendido" es la que GitHub ya modela — `isResolved` — y mutar el body del
// comentario de un humano para tacharlo sería pisarle su propio registro.
// Por eso los TaskComment que salen de acá con origen `pr-review` van SIN
// `id`: `markCommentsUsed` los saltea (filtra por id) y siguen apareciendo en
// cada run hasta que alguien —o el agente, con `resolve_pr_review_thread`—
// resuelva el hilo. Que un pedido sin resolver siga insistiendo es el
// comportamiento correcto, no ruido.

import type { CommentTarget, PullRequestRef, TaskComment } from '@ia-flow/shared'
import { ERROR_COMMENT_MARKER, USED_COMMENT_MARKER } from '../dispatch/comment-window.js'
import { createLogger } from '../logger.js'
import { gql } from './client.js'
import { openPullRequests } from './dev-links.js'
import { addIssueComment } from './issue.js'

const log = createLogger('github-conversation')

// `last: 50` (NO `first: 50, orderBy: UPDATED_AT DESC`) — ver el razonamiento
// completo abajo, en fetchConversation: `markCommentsUsed` muta el body de un
// comentario y le bumpea su propio updatedAt, así que ordenar por eso se
// auto-sabotea.
const COMMENTS_PAGE = 50
// Los threads son bastante menos que los comentarios y sólo nos interesan los
// no resueltos, que en un PR sano son pocos.
const REVIEW_THREADS_PAGE = 30
const THREAD_REPLIES_PAGE = 20

interface RawAuthor {
  login?: string
}

interface RawComment {
  id?: string
  body?: string
  createdAt?: string
  author?: RawAuthor | null
}

interface RawReviewThread {
  id?: string
  isResolved?: boolean
  path?: string
  line?: number | null
  comments?: { nodes?: RawComment[] } | null
}

interface RawNode {
  __typename?: string
  id?: string
  number?: number
  comments?: { nodes?: RawComment[] } | null
  reviewThreads?: { nodes?: RawReviewThread[] } | null
}

const COMMENT_FIELDS = `id body createdAt author { login }`

const CONVERSATION_QUERY = `
  query TaskConversation($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Issue {
        id
        comments(last: ${COMMENTS_PAGE}) { nodes { ${COMMENT_FIELDS} } }
      }
      ... on PullRequest {
        id
        number
        comments(last: ${COMMENTS_PAGE}) { nodes { ${COMMENT_FIELDS} } }
        reviewThreads(last: ${REVIEW_THREADS_PAGE}) {
          nodes {
            id
            isResolved
            path
            line
            comments(first: ${THREAD_REPLIES_PAGE}) { nodes { ${COMMENT_FIELDS} } }
          }
        }
      }
    }
  }
`

/**
 * El PR abierto donde aterriza un comentario dirigido al código: el de número
 * más alto, o sea el más reciente.
 *
 * Con varios abiertos el más nuevo es el que refleja el intento vigente; los
 * anteriores quedaron abiertos por descuido, no porque sean el trabajo actual.
 */
function targetPullRequest(prs: readonly PullRequestRef[] | undefined): PullRequestRef | undefined {
  const open = openPullRequests(prs)
  if (!open.length) return undefined
  return open.reduce((best, pr) => (pr.number > best.number ? pr : best))
}

/**
 * Publica en el destino que corresponde y devuelve dónde cayó.
 *
 * `addComment(subjectId:)` funciona igual contra un Issue que contra un
 * PullRequest, así que esto es la misma mutación con otro id — no hay un
 * camino de escritura distinto para el PR.
 *
 * **`pr` sin PR abierto cae al issue**, no falla. Un comentario que no se
 * publica se pierde entero, y perder el reporte de un run es peor que dejarlo
 * en el lugar menos específico; queda el warn para que se vea que pasó.
 */
export async function postToTarget(
  issueId: string,
  body: string,
  target: CommentTarget,
  pullRequests?: readonly PullRequestRef[],
): Promise<{ subject: 'issue' | 'pr'; prNumber?: number }> {
  const pr = target === 'issue' ? undefined : targetPullRequest(pullRequests)
  if (!pr) {
    if (target === 'pr') {
      log.warn(
        { issueId },
        'El comentario pedía el PR y no hay ninguno abierto — publicado en el issue',
      )
    }
    await addIssueComment(issueId, body)
    return { subject: 'issue' }
  }
  await addIssueComment(pr.nodeId as string, body)
  return { subject: 'pr', prNumber: pr.number }
}

// ─── Escritura sobre review threads ───────────────────────────────────────
//
// La contracara de leer las reviews. Sin esto un agente puede enterarse de un
// pedido de cambio pero sólo contestarlo en la conversación general del PR,
// donde el reviewer tiene que cruzarlo a mano contra sus propios comentarios —
// y donde GitHub no lo cuenta como atendido.

/** Responde DENTRO del hilo, que es donde el reviewer va a buscar la respuesta. */
export async function replyToReviewThread(threadId: string, body: string): Promise<void> {
  await gql(
    `mutation ReplyToReviewThread($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
        comment { id }
      }
    }`,
    { threadId, body },
  )
}

/** Marca el hilo como resuelto — el equivalente de `markCommentsUsed` para una
 *  review, pero con la semántica que GitHub ya modela y el humano ya entiende,
 *  en vez de un marker HTML escondido en el body. */
export async function resolveReviewThread(threadId: string): Promise<void> {
  await gql(
    `mutation ResolveReviewThread($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { id isResolved }
      }
    }`,
    { threadId },
  )
}

/** Lo que se descarta es "qué es ilegible del timeline", independiente de qué
 *  run lo pida: feedback que un run anterior ya consumió, y el stack trace
 *  crudo de `postError` (que hoy sólo sale del crash del run — el fallo que
 *  reporta `fail_task` ya vino legible por `postComment`). */
function isReadable(body: string | undefined): boolean {
  if (!body) return false
  return !body.includes(USED_COMMENT_MARKER) && !body.includes(ERROR_COMMENT_MARKER)
}

function mapComment(
  raw: RawComment,
  origin: 'issue' | 'pr',
  prNumber?: number,
): TaskComment | null {
  if (!raw.id || !raw.createdAt || !isReadable(raw.body)) return null
  return {
    id: raw.id,
    body: raw.body as string,
    created_at: raw.createdAt,
    origin,
    ...(prNumber != null ? { prNumber } : {}),
    ...(raw.author?.login ? { author: raw.author.login } : {}),
  }
}

/**
 * Una review thread se colapsa en UN TaskComment, no uno por respuesta.
 *
 * El hilo es la unidad de sentido —el pedido más sus respuestas— y es también
 * la unidad sobre la que se actúa (`reply_pr_review_thread` /
 * `resolve_pr_review_thread` toman el thread, no el comentario). Partirlo en N
 * entradas le daría al modelo N pedidos donde hay uno.
 *
 * `created_at` es el del ÚLTIMO comentario del hilo: lo que importa para la
 * ventana de recencia es cuándo se movió por última vez, no cuándo se abrió —
 * si no, una respuesta nueva a un hilo viejo entraría al prompt fechada en el
 * pasado y quedaría fuera de la ventana justo cuando es la novedad.
 */
function mapReviewThread(raw: RawReviewThread, prNumber: number): TaskComment | null {
  if (!raw.id || raw.isResolved) return null
  const comments = (raw.comments?.nodes ?? []).filter((c) => isReadable(c.body) && c.createdAt)
  if (!comments.length) return null

  const location = raw.path ? `${raw.path}${raw.line != null ? `:${raw.line}` : ''}` : 'el PR'
  const rendered = comments
    .map((c) => {
      const who = c.author?.login ?? 'alguien'
      return `**${who}:** ${(c.body ?? '').trim()}`
    })
    .join('\n\n')

  const last = comments[comments.length - 1]
  const first = comments[0]
  return {
    // Sin `id` a propósito — ver la cabecera del archivo: estos no se marcan
    // como usados, se resuelven.
    body: `Review sin resolver en \`${location}\`\n\n${rendered}`,
    created_at: last?.createdAt as string,
    origin: 'pr-review',
    prNumber,
    threadId: raw.id,
    ...(raw.path ? { path: raw.path } : {}),
    ...(raw.line != null ? { line: raw.line } : {}),
    ...(first?.author?.login ? { author: first.author.login } : {}),
  }
}

/**
 * Timeline completo de la task, en orden cronológico (viejo → nuevo).
 *
 * El orden importa: `selectCommentWindow` corta por recencia asumiendo esta
 * dirección, y `formatComments` la renderiza igual.
 *
 * `pullRequests` se filtra acá a los abiertos (`openPullRequests`), así que el
 * llamador puede pasarle lo que tenga en `meta.pullRequests` sin pre-filtrar.
 */
export async function fetchConversation(
  issueId: string,
  pullRequests?: readonly PullRequestRef[],
): Promise<TaskComment[]> {
  const open = openPullRequests(pullRequests)
  // `nodeId` está garantizado por openPullRequests, pero TS no lo sabe.
  const prByNodeId = new Map(open.map((pr) => [pr.nodeId as string, pr]))
  const ids = [issueId, ...prByNodeId.keys()]

  // `last: N` sin `orderBy` usa el orden natural (creación) de la conexión,
  // que es estable pase lo que pase con los updatedAt. Ordenar por UPDATED_AT
  // DESC se auto-sabotearía: `markCommentsUsed` muta el body de cada
  // comentario que consume, lo que bumpea su propio updatedAt y lo devuelve al
  // frente de la ventana — en un issue con ≥50 comentarios marcados, un
  // comentario humano genuinamente nuevo se cae de la página justo cuando hay
  // feedback real que leer.
  const data = await gql<{ nodes?: Array<RawNode | null> }>(CONVERSATION_QUERY, { ids })

  const out: TaskComment[] = []
  for (const node of data?.nodes ?? []) {
    if (!node) continue
    if (node.__typename === 'Issue') {
      for (const raw of node.comments?.nodes ?? []) {
        const mapped = mapComment(raw, 'issue')
        if (mapped) out.push(mapped)
      }
      continue
    }
    if (node.__typename !== 'PullRequest') continue
    // El número del ref es más confiable que el del nodo sólo por consistencia
    // con lo que la web ya muestra; si el nodo lo trae, da igual cuál se use.
    const prNumber = prByNodeId.get(node.id ?? '')?.number ?? node.number
    if (prNumber == null) continue
    for (const raw of node.comments?.nodes ?? []) {
      const mapped = mapComment(raw, 'pr', prNumber)
      if (mapped) out.push(mapped)
    }
    for (const raw of node.reviewThreads?.nodes ?? []) {
      const mapped = mapReviewThread(raw, prNumber)
      if (mapped) out.push(mapped)
    }
  }

  out.sort((a, b) => a.created_at.localeCompare(b.created_at))
  log.debug(
    { issueId, prs: open.length, comments: out.length },
    'Conversación de la task cargada (issue + PRs abiertos)',
  )
  return out
}
