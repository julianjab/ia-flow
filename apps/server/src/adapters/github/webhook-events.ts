// GitHub webhook → EngineEvent.
//
// Hasta acá, el único destino de un delivery era "re-escanear el board", así
// que todo lo que no fuera de issues se descartaba en el borde HTTP: 41
// deliveries de CI en 2 minutos, cero de issues, cada uno un `GET /issues`
// contra la cuota. Con el bus, un `pull_request` o un `check_suite` se entrega
// SÓLO a las reglas que lo pidieron y el resto no cuesta nada — que es lo que
// convierte la medición que justificaba el filtro en el argumento para abrirlo.
//
// Este módulo es puro: recibe el payload y un resolvedor de scope, y devuelve
// el evento. No conoce el bus ni la DB, así que se testea sin levantar nada.
import type { EngineEvent, EventScope } from '@ia-flow/shared'
import { createEvent } from '@ia-flow/shared'
import type { IWebhookTranslator, WebhookDelivery } from '../../domain/ports/IWebhookTranslator.js'

/** Tipos que el engine publica al bus. Los de issue siguen yendo por el camino
 *  del re-scan (ver `routes/webhooks.ts`); éstos son los nuevos. */
export const PR_OPENED = 'pr.opened'
export const PR_CLOSED = 'pr.closed'
export const PR_MERGED = 'pr.merged'
export const PR_SYNCHRONIZED = 'pr.synchronize'
export const PR_READY = 'pr.ready_for_review'
export const PR_REVIEW_SUBMITTED = 'pr.review_submitted'
export const CI_FINISHED = 'ci.finished'

/** Resuelve a qué proyecto y repo de ia-flow pertenece un `owner/repo` de
 *  GitHub. Sin él, el evento queda sin scope y —fail-closed— sólo lo verían
 *  las reglas globales. */
export type ScopeResolver = (
  owner: string,
  repo: string,
) => { projectId?: string; repoName?: string } | null

interface RawPayload {
  action?: string
  repository?: { name?: string; owner?: { login?: string }; full_name?: string }
  pull_request?: Record<string, unknown>
  review?: Record<string, unknown>
  check_suite?: Record<string, unknown>
  workflow_run?: Record<string, unknown>
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
 * `pull_request` → uno de los `pr.*`, o `null` cuando la acción no interesa.
 *
 * `closed` se parte en dos tipos (`pr.merged` / `pr.closed`) en vez de dejar
 * que cada regla mire `payload.merged`: son dos hechos distintos con
 * consecuencias distintas, y obligar a condicionar sobre un flag es la clase
 * de detalle que se olvida y produce una regla que dispara de más.
 */
export function pullRequestEvent(
  payload: RawPayload,
  resolve: ScopeResolver,
  deliveryId?: string,
): EngineEvent | null {
  const pr = payload.pull_request
  if (!pr) return null

  const type =
    payload.action === 'opened' || payload.action === 'reopened'
      ? PR_OPENED
      : payload.action === 'synchronize'
        ? PR_SYNCHRONIZED
        : payload.action === 'ready_for_review'
          ? PR_READY
          : payload.action === 'closed'
            ? pr.merged === true
              ? PR_MERGED
              : PR_CLOSED
            : null
  if (!type) return null

  const number = typeof pr.number === 'number' ? pr.number : undefined
  return createEvent({
    // El delivery id de GitHub ES la identidad del hecho: GitHub reintenta un
    // delivery fallido con el mismo id, y sin esto un reintento dispararía las
    // reglas dos veces.
    ...(deliveryId ? { id: `${deliveryId}:${type}` } : {}),
    type,
    source: 'github',
    scope: scopeFor(payload, resolve, number ? { prNumber: number } : {}),
    payload: { action: payload.action, pr: prPayload(pr) },
  })
}

/** `pull_request_review` → `pr.review_submitted`. Sólo `submitted`: `edited` y
 *  `dismissed` no son un veredicto nuevo. */
export function pullRequestReviewEvent(
  payload: RawPayload,
  resolve: ScopeResolver,
  deliveryId?: string,
): EngineEvent | null {
  const pr = payload.pull_request
  const review = payload.review
  if (!pr || !review || payload.action !== 'submitted') return null

  const number = typeof pr.number === 'number' ? pr.number : undefined
  return createEvent({
    ...(deliveryId ? { id: `${deliveryId}:${PR_REVIEW_SUBMITTED}` } : {}),
    type: PR_REVIEW_SUBMITTED,
    source: 'github',
    scope: scopeFor(payload, resolve, number ? { prNumber: number } : {}),
    payload: {
      // `approved` | `changes_requested` | `commented`
      state: typeof review.state === 'string' ? review.state.toLowerCase() : undefined,
      reviewer: (review.user as { login?: string } | undefined)?.login,
      body: review.body,
      pr: prPayload(pr),
    },
  })
}

/**
 * `check_suite` / `workflow_run` completados → `ci.finished`.
 *
 * Los dos se normalizan al MISMO tipo porque para una regla son el mismo
 * hecho: el CI de este commit terminó y ésta es su conclusión. Publicar
 * `check_suite.completed` y `workflow_run.completed` por separado obligaría a
 * cada regla a listar los dos, y a acordarse de agregar el tercero el día que
 * aparezca.
 */
export function ciFinishedEvent(
  event: string,
  payload: RawPayload,
  resolve: ScopeResolver,
  deliveryId?: string,
): EngineEvent | null {
  if (payload.action !== 'completed') return null
  const run = event === 'check_suite' ? payload.check_suite : payload.workflow_run
  if (!run) return null

  // Un PR asociado, cuando GitHub lo conoce. Sin él el evento igual sirve
  // (una regla puede condicionar por branch), pero pierde el `prNumber` del
  // scope, que es lo que ata el resultado a una task.
  const prs = run.pull_requests as Array<{ number?: number }> | undefined
  const prNumber = typeof prs?.[0]?.number === 'number' ? prs[0].number : undefined

  return createEvent({
    ...(deliveryId ? { id: `${deliveryId}:${CI_FINISHED}` } : {}),
    type: CI_FINISHED,
    source: 'github',
    scope: scopeFor(payload, resolve, prNumber ? { prNumber } : {}),
    payload: {
      // `success` | `failure` | `cancelled` | `timed_out` | `neutral` | …
      conclusion: run.conclusion,
      status: run.status,
      name: run.name,
      branch: run.head_branch,
      sha: run.head_sha,
      url: run.html_url,
      // De qué mecanismo vino, por si una regla quiere distinguirlos aunque el
      // tipo de evento sea el mismo.
      kind: event,
      prNumber,
    },
  })
}

/** Despacha al normalizador que corresponda. `null` = este delivery no produce
 *  ningún evento (una acción que no interesa, o un payload incompleto). */
export function githubWebhookEvent(
  event: string,
  payload: Record<string, unknown>,
  resolve: ScopeResolver,
  deliveryId?: string,
): EngineEvent | null {
  const raw = payload as RawPayload
  if (event === 'pull_request') return pullRequestEvent(raw, resolve, deliveryId)
  if (event === 'pull_request_review') return pullRequestReviewEvent(raw, resolve, deliveryId)
  if (event === 'check_suite' || event === 'workflow_run')
    return ciFinishedEvent(event, raw, resolve, deliveryId)
  return null
}

/** Los deliveries que producen un evento del bus. Complementa a `ISSUE_EVENTS`,
 *  que sigue disparando el re-scan del board. */
export const BUS_EVENTS = new Set([
  'pull_request',
  'pull_request_review',
  'check_suite',
  'workflow_run',
])

export function isBusEvent(event: string): boolean {
  return BUS_EVENTS.has(event)
}

/**
 * El traductor de GitHub, como port.
 *
 * Recibe el resolvedor de scope por constructor y no lo importa: el lookup
 * `owner/repo` → proyecto necesita la DB, y este módulo tiene que poder
 * testearse sin una. El container le inyecta el repo real; un test le pasa una
 * función de dos líneas.
 */
export class GithubWebhookTranslator implements IWebhookTranslator {
  readonly source = 'github'

  constructor(private readonly resolveScope: ScopeResolver) {}

  handles(event: string): boolean {
    return isBusEvent(event)
  }

  translate({ event, payload, deliveryId }: WebhookDelivery): EngineEvent | null {
    return githubWebhookEvent(event, payload, this.resolveScope, deliveryId)
  }
}
