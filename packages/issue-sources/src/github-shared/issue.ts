// GitHub issue-level REST/GraphQL calls — no Projects v2 board involved.
// Shared by github-project/ (task-source.ts, source.ts read comments/blockers
// off the linked issue, not the board) and github-issues/ (the whole source
// IS these calls, no board layer on top). Anything that touches a
// ProjectV2/project item stays in github-project/api/project.ts instead.
import { gql, rest } from './client.js'

export interface IssueComment {
  id: string
  body: string
  created_at: string
}

// Los markers viven en dispatch/comment-window.ts junto a la lógica que los
// interpreta — acá sólo se estampan. Se re-exportan porque los dos sources de
// GitHub los importan desde este módulo.
export {
  ERROR_COMMENT_MARKER,
  IA_FLOW_MARKER_PREFIX,
  SYSTEM_COMMENT_MARKER,
  USED_COMMENT_MARKER,
} from '../dispatch/comment-window.js'
import { ERROR_COMMENT_MARKER, USED_COMMENT_MARKER } from '../dispatch/comment-window.js'

export async function fetchIssueComments(issueId: string): Promise<IssueComment[]> {
  // `last: 50` (NOT `first: 50, orderBy: UPDATED_AT DESC`) — GitHub's
  // IssueCommentOrderField only exposes UPDATED_AT, and markCommentsUsed
  // below mutates a comment's body, which bumps ITS OWN updatedAt. Ordering
  // by UPDATED_AT DESC would then self-sabotage: every comment this same
  // mechanism just marked "used" jumps back to the front of the window (as
  // does every system comment complete_task/fail_task just posted), so on
  // an issue with ≥50 marked/system comments a genuinely new human comment
  // gets pushed outside the fetched page and `{{task.comments}}` renders
  // empty right when there's real feedback. `last: N` with no `orderBy`
  // uses the connection's natural (creation) order instead — stable
  // regardless of which comments get edited later — and already returns
  // oldest→newest, matching the order formatComments
  // (apps/server/src/variables/task.ts) renders in, so no reverse needed.
  const data = await gql<any>(
    `query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          comments(last: 50) {
            nodes { id body createdAt }
          }
        }
      }
    }`,
    { issueId },
  )
  // Qué se descarta acá es "qué es legible del issue", independiente de qué
  // run lo pida:
  //   • `comment-used`  — feedback humano que un run anterior ya consumió.
  //   • `agent-error`   — el stack trace crudo de postError (hoy sólo lo
  //                       emite el crash del run: cuando el fallo lo reporta
  //                       `fail_task`, ese comentario no se publica).
  // Los comentarios con SYSTEM_COMMENT_MARKER SÍ pasan: son el handoff entre
  // agentes, no ruido. Antes se descartaban junto con los otros dos (un solo
  // filtro por el prefijo `<!-- ia-flow:`) y eso dejaba `{{task.comments}}`
  // vacío en todo issue sin comentarios humanos — o sea que un agente
  // re-despachado por el fallo de otro nunca se enteraba de por qué corría.
  // Acotarlos a los relevantes para ESTE run es trabajo de selectCommentWindow
  // (dispatch/comment-window.ts), que necesita saber qué agente corre.
  return (data.node.comments.nodes as any[])
    .filter(
      (c) => !c.body?.includes(USED_COMMENT_MARKER) && !c.body?.includes(ERROR_COMMENT_MARKER),
    )
    .map((c) => ({ id: c.id, body: c.body as string, created_at: c.createdAt as string }))
}

/**
 * Marks human comments as "read" so they stop showing up in `{{task.comments}}`
 * on subsequent runs of the same task — without this, a piece of feedback left
 * once gets re-injected into every future retry indefinitely. Appends the
 * marker to each comment's OWN current body (passed in by the caller, who just
 * loaded them) — an earlier version of this replaced the whole body with just
 * the marker, silently destroying the original text.
 */
export async function markCommentsUsed(
  comments: Array<{ id: string; body: string }>,
): Promise<void> {
  await Promise.all(
    comments.map((c) =>
      gql(
        `mutation($id: ID!, $body: String!) {
          updateIssueComment(input: { id: $id, body: $body }) {
            issueComment { id }
          }
        }`,
        { id: c.id, body: `${c.body}\n\n${USED_COMMENT_MARKER}` },
      ).catch(() => {
        /* best-effort — a comment that fails to get marked just gets re-read
         * next run, not lost */
      }),
    ),
  )
}

export async function updateIssueBody(issueId: string, newBody: string): Promise<void> {
  await gql(
    `mutation($issueId: ID!, $body: String!) {
      updateIssue(input: { id: $issueId, body: $body }) {
        issue { id }
      }
    }`,
    { issueId, body: newBody },
  )
}

export async function addIssueComment(issueId: string, body: string): Promise<string> {
  const data = await gql<any>(
    `mutation($issueId: ID!, $body: String!) {
      addComment(input: { subjectId: $issueId, body: $body }) {
        commentEdge { node { id } }
      }
    }`,
    { issueId, body },
  )
  return data.addComment.commentEdge.node.id
}

export async function createIssue(
  owner: string,
  repo: string,
  title: string,
  body: string,
  // Optional: labels to apply at creation time. Needed by sources that
  // select issues purely by label (github-issues' anchorLabel/status:*) —
  // without this, a freshly created sub-issue would be invisible to the
  // engine until someone labeled it by hand. GitHub Projects v2 issues don't
  // need this (visibility there comes from add_to_project instead), so it's
  // optional and omitted when unset.
  labels?: string[],
): Promise<{ id: string; numericId: number; number: number; url: string }> {
  const data = (await rest(`/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: labels?.length ? { title, body, labels } : { title, body },
  })) as { id: number; node_id: string; number: number; html_url: string }
  return { id: data.node_id, numericId: data.id, number: data.number, url: data.html_url }
}

// ─── Link a sub-issue to a parent issue (GitHub native sub-issues) ────────

export async function addSubIssue(
  owner: string,
  repo: string,
  parentNumber: number,
  childNumericId: number,
): Promise<void> {
  await rest(`/repos/${owner}/${repo}/issues/${parentNumber}/sub_issues`, {
    method: 'POST',
    body: { sub_issue_id: childNumericId },
  })
}

/**
 * Índice COMPACTO de los sub-issues de un padre: número, título, estado y url.
 *
 * Existe porque el `list_sub_issues` del MCP de GitHub devuelve los issues
 * ENTEROS —body incluido—, y en una épica de verdad eso es una sola llamada
 * que se come el contexto del agente: en `la-haus/subscriptions#1243` son 21
 * hijos con ~154K caracteres sólo de bodies, más el envoltorio JSON de cada
 * uno. Un refiner que quería saber "qué hermanos existen" se quedaba sin
 * ventana antes de abrir un archivo del repo.
 *
 * Devuelve lo que hace falta para DECIDIR a quién leer; el body de un hijo
 * puntual se pide después con la tool del MCP.
 *
 * Pagina hasta agotar: una épica puede pasar los 30 del default de la API, y
 * un índice truncado en silencio es peor que uno caro — el consumidor
 * concluiría que un hermano no existe.
 */
export async function listSubIssues(
  owner: string,
  repo: string,
  parentNumber: number,
): Promise<Array<{ number: number; title: string; state: string; url: string }>> {
  const out: Array<{ number: number; title: string; state: string; url: string }> = []
  const perPage = 100
  for (let page = 1; ; page++) {
    const data = await rest(
      `/repos/${owner}/${repo}/issues/${parentNumber}/sub_issues?per_page=${perPage}&page=${page}`,
    )
    // Guarda de forma: `rest()` ya tira con cualquier `!res.ok`, así que acá
    // sólo llega un 200 con forma inesperada (el endpoint cambia, un
    // `{message}` con 200, la preview se retira). TIRA, no degrada a lista
    // vacía: `[]` es indistinguible de "este padre no tiene sub-issues", y
    // ese es justo el dato con el que el functional-refiner decide entre
    // reconciliar y CREAR — un `[]` espurio sobre un épico ya desglosado le
    // haría recrear los 21 hijos. Fallar deja el motivo en el run; mentir
    // duplica issues en GitHub.
    if (!Array.isArray(data)) {
      throw new Error(
        `sub_issues de #${parentNumber} (página ${page}) devolvió algo que no es una lista: ${JSON.stringify(data)?.slice(0, 200)}`,
      )
    }
    const batch = data as any[]
    for (const i of batch) {
      out.push({ number: i.number, title: i.title, state: i.state, url: i.html_url })
    }
    if (batch.length < perPage) return out
  }
}

// ─── Issue dependencies (blocked by / blocking) ───────────────────────────

export async function addBlockedBy(
  issueNodeId: string,
  blockingIssueNodeId: string,
): Promise<void> {
  await gql(
    `mutation($issueId: ID!, $blockingIssueId: ID!) {
      addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
        issue { id }
      }
    }`,
    { issueId: issueNodeId, blockingIssueId: blockingIssueNodeId },
  )
}

export async function getBlockingIssues(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<Array<{ number: number; state: string; title: string }>> {
  const data = (await rest(
    `/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
  )) as any[]
  return (data ?? []).map((i: any) => ({ number: i.number, state: i.state, title: i.title }))
}
