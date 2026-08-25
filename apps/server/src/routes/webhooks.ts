import { createHmac, timingSafeEqual } from 'crypto'
import {
  type WebhookHint,
  deliverWebhook,
  envDaemonMode,
  listWebhookTargets,
  resolveDaemonMode,
  triggerWebhookTarget,
} from '@ia-flow/issue-sources'
import { Hono } from 'hono'
import { broadcast, projectRepo } from '../composition/container.js'
import { createLogger } from '../logger.js'

const log = createLogger('webhooks')

// Shared secret for incoming deliveries. These endpoints are meant to be
// reachable from the internet (a tunnel in dev), and triggering a scan costs
// real GitHub GraphQL budget and can dispatch agents — so they fail *closed*:
// with no secret configured every route below answers 503, never "open".
//
// Read lazily so a secret stored in the DB (envRepo.loadIntoProcess runs after
// module import) is picked up.
function webhookSecret(): string | undefined {
  const raw = process.env.IA_FLOW_WEBHOOK_SECRET?.trim()
  return raw ? raw : undefined
}

const NO_SECRET_BODY = {
  error: 'webhook endpoints disabled: IA_FLOW_WEBHOOK_SECRET is not configured',
} as const

/** Constant-time string compare that tolerates length mismatch. */
function secretEquals(provided: string | undefined, secret: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Verify GitHub's `x-hub-signature-256` header (HMAC-SHA256 of the raw body).
 * Exported for tests.
 */
export function verifyGithubSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  const a = Buffer.from(expected)
  const b = Buffer.from(header)
  // timingSafeEqual throws on length mismatch — compare lengths first.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Qué deliveries llegan a disparar un scan. Todo lo demás se acusa con 200 y
// se descarta acá, en el borde.
//
// El registry es deliberadamente conservador: cualquier delivery que matchee
// el repo dispara un ciclo de scan completo ("mejor un scan de más que un
// evento perdido"). Eso, con un webhook suscrito a todos los eventos, hace
// que el push del propio agente encienda CI y el CI devuelva decenas de
// `workflow_run`/`workflow_job`/`check_run`/`check_suite` — cada uno un
// `GET /issues` contra la cuota REST — sin que ninguno cambie un issue. Se
// midieron 41 deliveries y 41 scans en 2 minutos, cero de ellos de issues.
//
// `projects_v2_item`/`projects_v2` entran igual que `issues`: en un proyecto
// GitHub Projects el cambio de status de un issue viaja por ahí, no por
// `issues` — filtrarlos dejaría al source de projects sin su único disparador.
// Cuando el dispatcher sepa reaccionar al resultado de un workflow sin
// re-escanear el board entero, la lista crece.
const ISSUE_EVENTS = new Set(['issues', 'issue_comment', 'projects_v2_item', 'projects_v2'])

/** ¿Este delivery puede cambiar un issue? Exportado para tests. */
export function isIssueEvent(event: string): boolean {
  return ISSUE_EVENTS.has(event)
}

/**
 * Pull the routing discriminators out of a GitHub webhook payload. Handles the
 * events that can change a board: `projects_v2_item`, `projects_v2`, plus
 * issue/PR events that only tell us the repository.
 * Exported for tests.
 */
export function githubHint(event: string, payload: Record<string, unknown>): WebhookHint {
  const item = payload.projects_v2_item as Record<string, unknown> | undefined
  const project = payload.projects_v2 as Record<string, unknown> | undefined
  const repo = payload.repository as Record<string, unknown> | undefined
  const projectNodeId =
    (item?.project_node_id as string | undefined) ?? (project?.node_id as string | undefined)
  return {
    event,
    ...(projectNodeId ? { projectNodeId } : {}),
    ...(typeof repo?.full_name === 'string' ? { repoFullName: repo.full_name } : {}),
  }
}

export function createWebhooksRouter() {
  const router = new Hono()

  // POST /api/webhooks/github — GitHub delivery endpoint.
  //
  // Point a repository/organization webhook here (content type
  // `application/json`, secret = IA_FLOW_WEBHOOK_SECRET) with at least the
  // "Projects v2 item" events; issues/issue_comment are useful too.
  router.post('/github', async (c) => {
    const secret = webhookSecret()
    if (!secret) {
      log.warn('Rejected webhook: IA_FLOW_WEBHOOK_SECRET is not configured')
      return c.json(NO_SECRET_BODY, 503)
    }
    // Read the raw body — the signature is over the exact bytes GitHub sent.
    const raw = await c.req.text()

    if (!verifyGithubSignature(raw, c.req.header('x-hub-signature-256'), secret)) {
      log.warn({ delivery: c.req.header('x-github-delivery') }, 'Rejected webhook: bad signature')
      return c.json({ error: 'invalid signature' }, 401)
    }

    const event = c.req.header('x-github-event') ?? 'unknown'
    const deliveryId = c.req.header('x-github-delivery')

    // GitHub's handshake — answer 200 so the hook shows as healthy.
    if (event === 'ping') return c.json({ ok: true, pong: true })

    // Todo lo que no pueda cambiar un issue muere acá: 200 (para que GitHub
    // no marque el hook como fallando) pero sin scan ni broadcast. Ver
    // ISSUE_EVENTS arriba para por qué esto no se resuelve del lado del
    // registry.
    if (!isIssueEvent(event)) {
      return c.json({ ok: true, event, ignored: true, triggered: [] })
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }

    const hint: WebhookHint = {
      ...githubHint(event, payload),
      ...(deliveryId ? { deliveryId } : {}),
    }
    // Carries the raw payload to matched targets only (deliverWebhook fans
    // out to matches, never the whole registry) — lets github-issues build a
    // SourceItem directly from payload.issue instead of re-fetching.
    const triggered = await deliverWebhook(hint, { event, payload })
    broadcast.send({
      type: 'daemon:webhook',
      event,
      deliveryId,
      projectIds: triggered,
      at: new Date().toISOString(),
    })
    return c.json({ ok: true, event, triggered })
  })

  // POST /api/webhooks/projects/:id — provider-agnostic nudge. Anything that
  // can issue an HTTP request (a Linear automation, a CI step, `curl` while
  // debugging) can wake one project's scan cycle.
  router.post('/projects/:id', async (c) => {
    const secret = webhookSecret()
    if (!secret) return c.json(NO_SECRET_BODY, 503)
    const provided =
      c.req.header('x-ia-flow-token') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (!secretEquals(provided, secret)) return c.json({ error: 'invalid token' }, 401)

    const id = c.req.param('id')
    const project = projectRepo.get(id)
    if (!project) return c.json({ error: 'project not found' }, 404)

    const reason = c.req.query('reason') ?? 'manual'
    const ok = triggerWebhookTarget(id, `manual:${reason}`)
    if (!ok) {
      return c.json(
        {
          error: 'project is not in webhook mode',
          projectId: id,
          mode: resolveDaemonMode(project),
        },
        409,
      )
    }
    return c.json({ ok: true, projectId: id, triggered: true })
  })

  // GET /api/webhooks/status — what the daemon is listening on, per project.
  //
  // Read-only and unauthenticated, like the rest of the local API (it exposes
  // no more than GET /api/projects already does). The two POSTs above are the
  // only routes meant to face the internet — when tunnelling, publish
  // `/api/webhooks/github` alone, not the whole server.
  router.get('/status', (c) => {
    const targets = listWebhookTargets()
    const byId = new Map(targets.map((t) => [t.projectId, t]))
    const projects = projectRepo.list().map((p) => ({
      projectId: p.id,
      name: p.name,
      mode: resolveDaemonMode(p),
      webhook: byId.get(p.id) ?? null,
    }))
    return c.json({
      defaultMode: envDaemonMode(),
      secretConfigured: Boolean(webhookSecret()),
      endpoint: '/api/webhooks/github',
      projects,
    })
  })

  return router
}
