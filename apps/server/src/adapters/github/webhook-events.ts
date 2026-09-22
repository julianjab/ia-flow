// GitHub webhook → EngineEvent.
//
// Hasta acá, el único destino de un delivery era "re-escanear el board", así
// que todo lo que no fuera de issues se descartaba en el borde HTTP: 41
// deliveries de CI en 2 minutos, cero de issues, cada uno un `GET /issues`
// contra la cuota. Con el bus, un `pull_request` o un `check_suite` se entrega
// SÓLO a las reglas que lo pidieron y el resto no cuesta nada — que es lo que
// convierte la medición que justificaba el filtro en el argumento para abrirlo.
//
// **`EngineEvent.type` es EXACTAMENTE el nombre de evento que manda GitHub
// (`X-GitHub-Event`) — nunca un nombre inventado acá.** No hay taxonomía
// curada (`pr.opened`, `ci.finished`, `issues.<action>`) ni fusión de dos
// eventos reales en uno (`check_suite`+`workflow_run`). La razón: un nombre
// propio es una lista de casos que hay que mantener sincronizada a mano con
// lo que GitHub manda — y esa lista se desincroniza en silencio (`pull_request`
// con `action: 'edited'` no producía nada porque nadie lo agregó). Con el
// nombre crudo, CUALQUIER `action` de un evento soportado se publica sin que
// haga falta enumerarlas, y distinguir por `action` (o por un campo como
// `pr.merged`) es trabajo del `when` de la regla — el DSL ya lo resuelve
// (`packages/rules/src/when.ts`), no hace falta un tipo de evento por
// combinación.
//
// Este módulo es puro: recibe el payload y un resolvedor de scope, y devuelve
// el evento. No conoce el bus ni la DB, así que se testea sin levantar nada.
import type { IssueItem } from '@ia-flow/issue-sources'
import type { EngineEvent, EventScope } from '@ia-flow/shared'
import { createEvent } from '@ia-flow/shared'
import type { IWebhookTranslator, WebhookDelivery } from '../../domain/ports/IWebhookTranslator.js'

interface RawPayload {
  action?: string
  repository?: { name?: string; owner?: { login?: string }; full_name?: string }
  pull_request?: Record<string, unknown>
  review?: Record<string, unknown>
  check_suite?: Record<string, unknown>
  workflow_run?: Record<string, unknown>
  issue?: Record<string, unknown>
  comment?: Record<string, unknown>
  projects_v2_item?: Record<string, unknown>
  projects_v2?: Record<string, unknown>
  changes?: Record<string, unknown>
  // Sólo presentes en ciertas `action` de `issues` — confirmado contra los
  // payload-examples reales de GitHub: `labeled`/`unlabeled` traen `label` a
  // nivel raíz (no anidado en `issue`); `assigned`/`unassigned` traen
  // `assignee` de la misma forma.
  label?: { name?: string }
  assignee?: { login?: string }
}

/** Los nombres de `issue.labels` — GitHub siempre manda el set COMPLETO y
 *  actual en `issue.labels`, aun en `labeled`/`unlabeled` (que además traen la
 *  única label afectada en `payload.label`, a nivel raíz). Sin fetch extra: ya
 *  viene en el delivery. */
function labelNames(issue: Record<string, unknown>): string[] {
  const raw = issue.labels
  if (!Array.isArray(raw)) return []
  return raw
    .map((l) => (l && typeof l === 'object' ? (l as { name?: unknown }).name : l))
    .filter((n): n is string => typeof n === 'string')
}

function ownerRepo(payload: RawPayload): { owner: string; repo: string } | null {
  const owner = payload.repository?.owner?.login
  const repo = payload.repository?.name
  if (typeof owner === 'string' && typeof repo === 'string') return { owner, repo }
  return null
}

function scopeFor(
  payload: RawPayload,
  resolve: ScopeResolver,
  extra: Partial<EventScope> = {},
): EventScope {
  const coords = ownerRepo(payload)
  const hit = coords ? resolve(coords.owner, coords.repo) : null
  return {
    ...(hit?.projectId ? { projectId: hit.projectId } : {}),
    // `repos` y no `repoName`: el matcher hace pertenencia contra una lista,
    // igual que con las tasks multi-repo.
    ...(hit?.repoName ? { repos: [hit.repoName] } : {}),
    ...extra,
  }
}

/** `projects_v2_item`/`projects_v2` no traen `owner/repo` — el match por
 *  `project_node_id` ya lo hizo la ruta (`deliverWebhook`, antes de llegar
 *  acá) y lo pasa en `delivery.projectIds`. Un repo registrado en dos
 *  proyectos devuelve el primero, mismo criterio que `scopeFor`. */
function scopeForProjectIds(projectIds: string[] | undefined): EventScope {
  return projectIds?.[0] ? { projectId: projectIds[0] } : {}
}

/** Resuelve a qué proyecto y repo de ia-flow pertenece un `owner/repo` de
 *  GitHub. Sin él, el evento queda sin scope y —fail-closed— sólo lo verían
 *  las reglas globales. */
export type ScopeResolver = (
  owner: string,
  repo: string,
) => { projectId?: string; repoName?: string } | null

/** Los campos del PR que una regla querría condicionar, aplanados con nombres
 *  camelCase — el DSL de `when` resuelve caminos anidados, pero un
 *  `pr.isDraft` es más legible que un `pr.draft` que sólo GitHub nombra así. */
function prPayload(pr: Record<string, unknown>): Record<string, unknown> {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    isDraft: pr.draft === true,
    merged: pr.merged === true,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    author: (pr.user as { login?: string } | undefined)?.login,
    head: (pr.head as { ref?: string; sha?: string } | undefined) ?? {},
    base: (pr.base as { ref?: string } | undefined) ?? {},
    url: pr.html_url,
  }
}

/**
 * `pull_request` → `pull_request`, para CUALQUIER `action`. Distinguir
 * `opened` de `edited`, o un `closed` mergeado de uno cerrado sin mergear
 * (`payload.pr.merged`), es trabajo del `when` de la regla — no de este
 * traductor.
 */
export function pullRequestEvent(
  payload: RawPayload,
  resolve: ScopeResolver,
  deliveryId?: string,
  traceId?: string,
): EngineEvent | null {
  const pr = payload.pull_request
  if (!pr) return null

  const number = typeof pr.number === 'number' ? pr.number : undefined
  return createEvent({
    // El delivery id de GitHub ES la identidad del hecho: GitHub reintenta un
    // delivery fallido con el mismo id, y sin esto un reintento dispararía las
    // reglas dos veces.
    ...(deliveryId ? { id: `${deliveryId}:pull_request:${payload.action}` } : {}),
    type: 'pull_request',
    source: 'github',
    traceId,
    scope: scopeFor(payload, resolve, number ? { prNumber: number } : {}),
    payload: { action: payload.action, pr: prPayload(pr) },
  })
}

/** `pull_request_review` → `pull_request_review`, para cualquier `action`
 *  (`submitted`, `edited`, `dismissed`). */
export function pullRequestReviewEvent(
  payload: RawPayload,
  resolve: ScopeResolver,
  deliveryId?: string,
  traceId?: string,
): EngineEvent | null {
  const pr = payload.pull_request
  const review = payload.review
  if (!pr || !review) return null

  const number = typeof pr.number === 'number' ? pr.number : undefined
  return createEvent({
    ...(deliveryId ? { id: `${deliveryId}:pull_request_review:${payload.action}` } : {}),
    type: 'pull_request_review',
    source: 'github',
    traceId,
    scope: scopeFor(payload, resolve, number ? { prNumber: number } : {}),
    payload: {
      action: payload.action,
      // `approved` | `changes_requested` | `commented` — normalizado a
      // minúsculas: una regla no debería tener que saber que GitHub lo manda
      // en mayúsculas.
      state: typeof review.state === 'string' ? review.state.toLowerCase() : undefined,
      reviewer: (review.user as { login?: string } | undefined)?.login,
      body: review.body,
      pr: prPayload(pr),
    },
  })
}

/**
 * `check_suite` / `workflow_run` → el mismo nombre crudo del evento, para
 * cualquier `action` (`requested`, `in_progress`, `completed`, …).
 *
 * Los dos ya NO se fusionan en un tipo propio: son dos eventos reales
 * distintos de GitHub. Una regla que quiere "terminó el CI, no importa el
 * mecanismo" escribe `on: ['check_suite', 'workflow_run']` +
 * `when: [{field: 'action', op: '=', value: 'completed'}]` — el array de
 * `on` ya expresa "cualquiera de estos".
 */
export function ciEvent(
  event: 'check_suite' | 'workflow_run',
  payload: RawPayload,
  resolve: ScopeResolver,
  deliveryId?: string,
  traceId?: string,
): EngineEvent | null {
  const run = event === 'check_suite' ? payload.check_suite : payload.workflow_run
  if (!run) return null

  // Un PR asociado, cuando GitHub lo conoce. Sin él el evento igual sirve
  // (una regla puede condicionar por branch), pero pierde el `prNumber` del
  // scope, que es lo que ata el resultado a una task.
  const prs = run.pull_requests as Array<{ number?: number }> | undefined
  const prNumber = typeof prs?.[0]?.number === 'number' ? prs[0].number : undefined

  return createEvent({
    ...(deliveryId ? { id: `${deliveryId}:${event}:${payload.action}` } : {}),
    type: event,
    source: 'github',
    traceId,
    scope: scopeFor(payload, resolve, prNumber ? { prNumber } : {}),
    payload: {
      action: payload.action,
      // `success` | `failure` | `cancelled` | `timed_out` | `neutral` | …
      // — sólo tiene valor una vez que `action === 'completed'`, `undefined`
      // en cualquier otro estado.
      conclusion: run.conclusion,
      status: run.status,
      name: run.name,
      branch: run.head_branch,
      sha: run.head_sha,
      url: run.html_url,
      prNumber,
      // De qué mecanismo vino, por si una regla escucha `on: [check_suite,
      // workflow_run]` a la vez y necesita distinguirlos en el `when` — el
      // tipo del evento no está disponible ahí (`when` evalúa sólo contra
      // `payload`, ver match.ts), así que sin esto una regla combinada no
      // podría diferenciarlos.
      kind: event,
    },
  })
}

/**
 * `issue_comment` → `issue_comment`, para cualquier `action` (`created`,
 * `edited`, `deleted`). `action` viaja en el payload, no en el tipo.
 */
export function issueCommentEvent(
  payload: RawPayload,
  resolve: ScopeResolver,
  deliveryId?: string,
  traceId?: string,
): EngineEvent | null {
  const issue = payload.issue
  const comment = payload.comment
  if (!issue || !comment) return null

  const issueNumber = typeof issue.number === 'number' ? issue.number : undefined
  const nodeId = typeof issue.node_id === 'string' ? issue.node_id : undefined
  return createEvent({
    ...(deliveryId ? { id: `${deliveryId}:issue_comment:${payload.action}:${comment.id}` } : {}),
    type: 'issue_comment',
    source: 'github',
    traceId,
    scope: scopeFor(payload, resolve, nodeId ? { issueId: nodeId } : {}),
    payload: {
      action: payload.action,
      body: comment.body,
      author: (comment.user as { login?: string } | undefined)?.login,
      commentUrl: comment.html_url,
      // Node id (GraphQL), no el numérico de REST — es lo que necesita la
      // mutación `addReaction` que usa `react_to_comment` (ver
      // packages/tools/src/github/tools.ts).
      commentId: typeof comment.node_id === 'string' ? comment.node_id : undefined,
      issueNumber,
    },
  })
}

/** `issues` → `issues`, para cualquier `action` (`opened`, `labeled`,
 *  `closed`, …). */
export function issuesEvent(
  payload: RawPayload,
  resolve: ScopeResolver,
  deliveryId?: string,
  traceId?: string,
): EngineEvent | null {
  const issue = payload.issue
  if (!issue) return null

  const issueNumber = typeof issue.number === 'number' ? issue.number : undefined
  const nodeId = typeof issue.node_id === 'string' ? issue.node_id : undefined
  return createEvent({
    ...(deliveryId ? { id: `${deliveryId}:issues:${payload.action}:${issueNumber}` } : {}),
    type: 'issues',
    source: 'github',
    traceId,
    scope: scopeFor(payload, resolve, nodeId ? { issueId: nodeId } : {}),
    payload: {
      action: payload.action,
      issueNumber,
      title: issue.title,
      state: issue.state,
      // Sólo presentes en `labeled`/`unlabeled`/`assigned`/`unassigned` — el
      // resto de las acciones los deja `undefined`, no ausentes (mismo
      // criterio que `fieldName`/`fieldType` en `projectItemEvent`).
      labelName: payload.label?.name,
      assignee: payload.assignee?.login,
      // Set completo y actual, no sólo la label que disparó `labeled`/
      // `unlabeled` — así `when: [{field:'labels', op:'contains', ...}]`
      // funciona igual que contra un Task/SourceItem, sin depender de que
      // `resolveItem` haya podido resolver `item.labels` (necesita el repo
      // ya registrado bajo un proyecto).
      labels: labelNames(issue),
    },
  })
}

/**
 * `projects_v2_item` → `projects_v2_item`, para cualquier `action`. El scope
 * NO sale de `owner/repo` (el payload no trae `repository`: un item de
 * Projects puede venir de cualquier repo del proyecto) — sale de
 * `projectIds`, que la ruta ya resolvió contra `webhook-registry` antes de
 * llegar acá.
 */
export function projectItemEvent(
  payload: RawPayload,
  projectIds: string[] | undefined,
  deliveryId?: string,
  traceId?: string,
): EngineEvent | null {
  const item = payload.projects_v2_item
  if (!item) return null

  const itemId = typeof item.node_id === 'string' ? item.node_id : undefined
  // GitHub NO manda el valor viejo/nuevo en este webhook, para ningún tipo de
  // campo — sólo dice QUÉ campo cambió (`field_name`/`field_type`), nunca a
  // qué. Confirmado contra un delivery real de `projects_v2_item.edited` con
  // `field_type: 'labels'`: `changes.field_value` no tiene ninguna clave de
  // valor. Para saber el valor actual hay que resolver `item` (`getItemById`)
  // — es justo lo que ya hace `resolveItem`, no un campo que falte acá.
  const fieldChange = payload.changes?.field_value as
    | { field_name?: unknown; field_type?: unknown }
    | undefined
  return createEvent({
    ...(deliveryId ? { id: `${deliveryId}:projects_v2_item:${payload.action}:${itemId}` } : {}),
    type: 'projects_v2_item',
    source: 'github',
    traceId,
    scope: { ...scopeForProjectIds(projectIds), ...(itemId ? { issueId: itemId } : {}) },
    payload: {
      action: payload.action,
      itemId,
      fieldName: fieldChange?.field_name,
      fieldType: fieldChange?.field_type,
    },
  })
}

/** `projects_v2` → `projects_v2` — cambió el proyecto en sí (un campo
 *  agregado, etc), no un item — no hay `issueId` que resolver acá. */
export function projectEvent(
  payload: RawPayload,
  projectIds: string[] | undefined,
  deliveryId?: string,
  traceId?: string,
): EngineEvent | null {
  const project = payload.projects_v2
  if (!project) return null

  return createEvent({
    ...(deliveryId ? { id: `${deliveryId}:projects_v2:${payload.action}` } : {}),
    type: 'projects_v2',
    source: 'github',
    traceId,
    scope: scopeForProjectIds(projectIds),
    payload: { action: payload.action },
  })
}

/** Despacha al normalizador que corresponda. `null` = este delivery no produce
 *  ningún evento (payload incompleto — nunca "acción que no interesa": eso ya
 *  no es un criterio de este traductor). */
export function githubWebhookEvent(
  event: string,
  payload: Record<string, unknown>,
  resolve: ScopeResolver,
  deliveryId?: string,
  projectIds?: string[],
  traceId?: string,
): EngineEvent | null {
  const raw = payload as RawPayload
  if (event === 'pull_request') return pullRequestEvent(raw, resolve, deliveryId, traceId)
  if (event === 'pull_request_review')
    return pullRequestReviewEvent(raw, resolve, deliveryId, traceId)
  if (event === 'check_suite' || event === 'workflow_run')
    return ciEvent(event, raw, resolve, deliveryId, traceId)
  if (event === 'issue_comment') return issueCommentEvent(raw, resolve, deliveryId, traceId)
  if (event === 'issues') return issuesEvent(raw, resolve, deliveryId, traceId)
  if (event === 'projects_v2_item') return projectItemEvent(raw, projectIds, deliveryId, traceId)
  if (event === 'projects_v2') return projectEvent(raw, projectIds, deliveryId, traceId)
  return null
}

/**
 * Los deliveries que producen un evento del bus. Los cuatro de issue/board
 * TAMBIÉN siguen disparando el re-scan (`ISSUE_EVENTS` en `routes/webhooks.ts`)
 * — son las dos cosas, no una en vez de la otra: el re-scan es lo que hace
 * que el modo `webhook` (push puro, sin pull) descubra que el item cambió; el
 * bus es lo nuevo, para que una regla pueda leer el contenido crudo del
 * webhook.
 */
export const BUS_EVENTS = new Set([
  'pull_request',
  'pull_request_review',
  'check_suite',
  'workflow_run',
  'issue_comment',
  'issues',
  'projects_v2_item',
  'projects_v2',
])

export function isBusEvent(event: string): boolean {
  return BUS_EVENTS.has(event)
}

/** Un node id de GitHub, con la etiqueta de qué TIPO de nodo es —
 *  `issue_comment`/`issues` sólo traen el node id del Issue, nunca el del
 *  ProjectV2Item (GitHub no lo manda en esos payloads); `projects_v2_item` es
 *  al revés. Confundir los dos es el bug que ya se diagnosticó para
 *  `issues.labeled`/`unlabeled` contra `projects_v2_item`: un id de un tipo
 *  pasado a un resolver que espera el otro no tira, sólo no matchea nunca —
 *  la etiqueta es lo que le permite al caller (`resolveItemById`, inyectado
 *  por el container) elegir el método correcto en vez de adivinar. */
export type TaggedNodeId = { kind: 'issue' | 'projectItem'; id: string }

/** El `node_id` del issue/PR/item al que habla este delivery, cuando el
 *  payload lo trae directo — `check_suite`/`workflow_run` no tienen uno
 *  (hablan de un commit, no de un issue) y `projects_v2` tampoco (habla del
 *  proyecto en sí), así que quedan sin `item`. */
function nodeIdFor(event: string, payload: RawPayload): TaggedNodeId | undefined {
  const from = (obj: Record<string, unknown> | undefined) => {
    const id = obj?.node_id
    return typeof id === 'string' ? id : undefined
  }
  if (event === 'pull_request' || event === 'pull_request_review') {
    const id = from(payload.pull_request)
    return id ? { kind: 'issue', id } : undefined
  }
  if (event === 'issue_comment' || event === 'issues') {
    const id = from(payload.issue)
    return id ? { kind: 'issue', id } : undefined
  }
  if (event === 'projects_v2_item') {
    const id = from(payload.projects_v2_item)
    return id ? { kind: 'projectItem', id } : undefined
  }
  return undefined
}

/** Resuelve un node id (etiquetado por tipo, ver `TaggedNodeId`) a un
 *  `IssueItem`, vía el fetch puntual que el `ProjectSource` del proyecto ya
 *  expone (`getItemById`/`getItemByIssueId`, 1 sola llamada — nunca un scan).
 *  Inyectado por función y no por instancia: el container ya arma un
 *  registry de sources para todo lo demás, y esto no necesita más que
 *  preguntarle. */
export type ItemResolver = (projectId: string, node: TaggedNodeId) => Promise<IssueItem | null>

/**
 * El traductor de GitHub, como port.
 *
 * Recibe el resolvedor de scope por constructor y no lo importa: el lookup
 * `owner/repo` → proyecto necesita la DB, y este módulo tiene que poder
 * testearse sin una. El container le inyecta el repo real; un test le pasa una
 * función de dos líneas. Mismo criterio para `resolveItemById`.
 */
export class GithubWebhookTranslator implements IWebhookTranslator {
  readonly source = 'github'

  constructor(
    private readonly resolveScope: ScopeResolver,
    private readonly resolveItemById?: ItemResolver,
  ) {}

  handles(event: string): boolean {
    return isBusEvent(event)
  }

  translate({
    event,
    payload,
    deliveryId,
    projectIds,
    traceId,
  }: WebhookDelivery): EngineEvent | null {
    return githubWebhookEvent(event, payload, this.resolveScope, deliveryId, projectIds, traceId)
  }

  async resolveItem(delivery: WebhookDelivery, event: EngineEvent): Promise<IssueItem | null> {
    const projectId = event.scope.projectId
    if (!projectId || !this.resolveItemById) return null
    const node = nodeIdFor(delivery.event, delivery.payload as RawPayload)
    if (!node) return null
    return this.resolveItemById(projectId, node)
  }
}
