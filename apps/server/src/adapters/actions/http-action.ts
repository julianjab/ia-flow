import type { ActionContext, ActionHandler, ActionResult } from '@ia-flow/rules'
import { HttpActionSchema } from '@ia-flow/shared'
import type { z } from 'zod'
import { createLogger } from '../../logger.js'

const log = createLogger('action:http')

const DEFAULT_TIMEOUT_MS = 30_000

type HttpConfig = z.infer<typeof HttpActionSchema>

/** `{{event.payload.pr.number}}` → el valor, resolviendo el camino anidado.
 *  Un placeholder que no resuelve queda como string vacío y no como el `{{...}}`
 *  crudo: mandar la sintaxis del template a una API externa es peor que mandar
 *  un hueco, porque del otro lado no hay forma de distinguirlo de un valor. */
function interpolate(template: string, event: ActionContext['event']): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const segments = path.split('.')
    let current: unknown = { event }
    for (const segment of segments) {
      if (current == null || typeof current !== 'object') return ''
      current = (current as Record<string, unknown>)[segment]
    }
    if (current == null) return ''
    return typeof current === 'string' ? current : JSON.stringify(current)
  })
}

function interpolateDeep(value: unknown, event: ActionContext['event']): unknown {
  if (typeof value === 'string') return interpolate(value, event)
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, event))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        interpolateDeep(v, event),
      ]),
    )
  }
  return value
}

export interface HttpActionDeps {
  /** Resuelve `${SECRETO}` en url, headers y body. Es el MISMO resolver que
   *  usan los MCP (`setSecretResolver`), así que un token no vive en la fila de
   *  la regla — se resuelve por uso, nunca se captura. */
  resolveSecrets(input: string): Promise<string>
  fetchImpl?: typeof fetch
}

/**
 * Llamar a una API cuando pasa un evento.
 *
 * Es la acción que no tiene ninguna de las redes que tiene un run de agente: si
 * el proceso muere entre el evento y la llamada, nadie se entera. Por eso su
 * ejecución la registra `action_runs` (ver el recorder de `runRule`).
 */
export class HttpAction implements ActionHandler<HttpConfig> {
  readonly kind = 'http'
  readonly configSchema = HttpActionSchema
  private readonly doFetch: typeof fetch

  constructor(private readonly deps: HttpActionDeps) {
    this.doFetch = deps.fetchImpl ?? fetch
  }

  async execute(ctx: ActionContext, config: HttpConfig): Promise<ActionResult> {
    const url = await this.deps.resolveSecrets(interpolate(config.url, ctx.event))
    const headers: Record<string, string> = {}
    for (const [key, raw] of Object.entries(config.headers ?? {})) {
      headers[key] = await this.deps.resolveSecrets(interpolate(raw, ctx.event))
    }

    let body: string | undefined
    if (config.body !== undefined && config.method !== 'GET') {
      const interpolated = interpolateDeep(config.body, ctx.event)
      body = await this.deps.resolveSecrets(
        typeof interpolated === 'string' ? interpolated : JSON.stringify(interpolated),
      )
      headers['content-type'] ??= 'application/json'
    }

    // Un timeout propio y no el del runtime: sin esto una API que no responde
    // cuelga la regla entera, y con ella el outcome que el dispatcher está
    // esperando para decidir si difiere el item.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    try {
      const res = await this.doFetch(url, {
        method: config.method,
        headers,
        body,
        signal: controller.signal,
      })
      const detail = `${config.method} ${res.status}`
      if (!res.ok) {
        // El cuerpo del error se trunca: puede ser una página HTML entera y
        // termina en una columna de SQLite y en un log.
        const text = (await res.text().catch(() => '')).slice(0, 500)
        log.warn({ url, status: res.status, ruleId: ctx.rule.id }, 'HTTP action failed')
        return { ok: false, detail: `${detail} ${text}`.trim() }
      }
      return { ok: true, detail }
    } finally {
      clearTimeout(timer)
    }
  }
}
