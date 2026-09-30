/**
 * El borde HTTP del runner — `node:http`, sin framework. Réplica acotada de `routes/webhooks.ts`
 * de ia-flow:
 *
 *   POST /api/webhooks/github   firma HMAC (`IA_FLOW_WEBHOOK_SECRET`) → 202 y el delivery sigue
 *                               en background. Sin secreto configurado responde 503: la ruta está
 *                               pensada para quedar expuesta a internet y dispara agentes, así
 *                               que falla CERRADA, nunca abierta.
 *   GET  /api/webhooks/status   qué escucha el runner — sólo lectura, sin datos sensibles.
 *   GET  /health                el proceso contesta: la probe de k8s y el healthcheck del
 *                               balanceador. No mira GitHub ni la base — un 200 es "sigo vivo".
 *
 * Responde ANTES de traducir y despachar: GitHub corta el delivery a los 10 s y una corrida de un
 * agente dura minutos. La contracara es que un error de traducción no le llega a GitHub como
 * fallo — queda en el log del runner.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { GithubWebhookVerifier } from '@ia-flow/github-webhook'

/** Un delivery ya verificado, tal cual lo mandó GitHub. */
export interface Delivery {
  /** `X-GitHub-Event`. */
  event: string
  /** `X-GitHub-Delivery` — GitHub reintenta con el mismo id. */
  id?: string
  payload: Record<string, unknown>
}

export const GITHUB_WEBHOOK_PATH = '/api/webhooks/github'
const STATUS_PATH = '/api/webhooks/status'
export const HEALTH_PATH = '/health'
/** El tope de GitHub para un payload de webhook. */
const MAX_BODY_BYTES = 25 * 1024 * 1024
/** Cuántos delivery ids recordar para descartar reintentos de GitHub. */
const DEDUPE_WINDOW = 1000

export interface WebhookServerOptions {
  /** `undefined` o vacío: POST responde 503. */
  secret: string | undefined
  /** Sigue en background después del 202 — sus errores sólo se loguean. */
  onDelivery: (delivery: Delivery) => Promise<void>
  /** Lo que `GET /api/webhooks/status` agrega a la respuesta. */
  status?: () => Record<string, unknown>
  /** La API de la web (`http/ApiRouter.ts`): si atiende la ruta, el webhook no la ve. */
  api?: { handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> }
  log: (line: string) => void
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge()
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export function createWebhookServer(opts: WebhookServerOptions): Server {
  const secret = opts.secret?.trim() || undefined
  const verifier = secret ? new GithubWebhookVerifier(secret) : undefined
  const seen = new Set<string>()

  /** El body, si está firmado por GitHub — o `undefined` si ya se respondió el rechazo (sin
   *  secreto, demasiado grande, firma inválida). La firma es sobre los bytes crudos: se verifica
   *  ANTES de parsear. */
  async function signedBody(
    req: IncomingMessage,
    res: ServerResponse,
    deliveryId: string | undefined,
  ): Promise<Buffer | undefined> {
    if (!verifier) {
      opts.log('webhook rechazado: IA_FLOW_WEBHOOK_SECRET no está configurado')
      send(res, 503, { error: 'IA_FLOW_WEBHOOK_SECRET no está configurado' })
      return undefined
    }
    let raw: Buffer
    try {
      raw = await readBody(req)
    } catch (err) {
      if (!(err instanceof BodyTooLarge)) throw err
      send(res, 413, { error: 'payload demasiado grande' })
      return undefined
    }
    if (!verifier.verify(raw, header(req, 'x-hub-signature-256'))) {
      opts.log(`webhook rechazado: firma inválida (delivery ${deliveryId ?? '?'})`)
      send(res, 401, { error: 'firma inválida' })
      return undefined
    }
    return raw
  }

  /** Si GitHub ya mandó este delivery (un reintento); si no, lo recuerda. */
  function isDuplicate(deliveryId: string | undefined): boolean {
    if (!deliveryId) return false
    if (seen.has(deliveryId)) return true
    seen.add(deliveryId)
    // Set conserva el orden de inserción: el primero es el más viejo.
    if (seen.size > DEDUPE_WINDOW) seen.delete(seen.values().next().value as string)
    return false
  }

  async function github(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const deliveryId = header(req, 'x-github-delivery')
    const raw = await signedBody(req, res, deliveryId)
    if (!raw) return

    const event = header(req, 'x-github-event') ?? 'unknown'
    if (event === 'ping') return send(res, 200, { ok: true, pong: true })

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>
    } catch {
      return send(res, 400, { error: 'body JSON inválido' })
    }
    if (isDuplicate(deliveryId)) {
      return send(res, 200, { ok: true, duplicate: true, delivery: deliveryId })
    }

    send(res, 202, { ok: true, accepted: true, event, delivery: deliveryId })
    opts.onDelivery({ event, id: deliveryId, payload }).catch((err: unknown) => {
      // Que un "Redeliver" manual desde GitHub (mismo id) pueda reintentarlo.
      if (deliveryId) seen.delete(deliveryId)
      opts.log(
        `webhook ${event} (${deliveryId ?? '?'}) falló: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const handle = async () => {
      if (req.method === 'POST' && path === GITHUB_WEBHOOK_PATH) return github(req, res)
      if (req.method === 'GET' && path === HEALTH_PATH) return send(res, 200, { ok: true })
      if (await opts.api?.handle(req, res)) return
      if (req.method === 'GET' && path === STATUS_PATH) {
        return send(res, 200, {
          endpoint: GITHUB_WEBHOOK_PATH,
          secretConfigured: Boolean(verifier),
          ...opts.status?.(),
        })
      }
      send(res, 404, { error: 'not found' })
    }
    handle().catch((err: unknown) => {
      opts.log(`servidor: ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) send(res, 500, { error: 'error interno' })
    })
  })
}
