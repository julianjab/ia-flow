// Llamada directa a Haiku para los ayudantes del engine (el `focus` de
// `fs_read` y la compactación del historial). No pasa por el provider del
// agente a propósito: son mecanismos internos del loop, con su propio modelo
// y su propio presupuesto, y no deben cambiar porque el agente corra en Opus
// o en un terminal.
//
// La credencial se lee POR LLAMADA (`Bun.env` en cada `askHaiku`), no al
// importar: `envRepo.loadIntoProcess()` vuelca lo guardado en SQLite después
// de que el composition root se evaluó, así que capturarla acá dejaría al
// helper ciego a lo que el operador pegó en Configuración.
import { type Logger, createLogger } from './logger.js'

const log = createLogger('haiku')

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

export function haikuAuthHeader(): Record<string, string> | null {
  const oauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  if (oauthToken) return { Authorization: `Bearer ${oauthToken}` }
  if (apiKey) return { 'x-api-key': apiKey }
  return null
}

export interface HaikuRequest {
  system: string
  user: string
  maxTokens: number
  /** Para el log: quién pide y sobre qué. */
  scope: Record<string, unknown>
  /**
   * Logger ya bindeado con la correlación del run que pide esto (`runId`,
   * `agent`, `taskId`, `projectId` — ver `logCtx` en el provider `anthropic-api`
   * y `logCtx` en `task.ts`). Sin esto, `askHaiku` loguea con el logger de
   * módulo desnudo y sus líneas quedan sin forma de cruzarse con las del
   * resto del run. Default: el logger de módulo, para callers ad-hoc/tests
   * que no tienen un run del que colgarse.
   */
  logger?: Logger
}

export interface HaikuResponse {
  text: string
  usage: unknown
  ms: number
}

/**
 * Una vuelta de Messages sin tools. Tira con el status HTTP cuando la API no
 * contesta 200; el que llama decide cómo degradar (cada helper tiene su
 * propio fallback, y ninguno debe voltear el run del agente).
 */
export async function askHaiku(req: HaikuRequest): Promise<HaikuResponse> {
  const auth = haikuAuthHeader()
  if (!auth) throw new Error('no auth for Haiku (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY)')
  const reqLog = req.logger ?? log

  reqLog.info(
    {
      ...req.scope,
      model: HAIKU_MODEL,
      userBytes: req.user.length,
      systemBytes: req.system.length,
    },
    'haiku request',
  )
  const t0 = Date.now()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...auth,
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    }),
  })
  const ms = Date.now() - t0
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    reqLog.warn(
      { ...req.scope, status: res.status, ms, err: errBody.slice(0, 500) },
      'haiku failed',
    )
    throw new Error(`Haiku ${res.status}`)
  }
  const data = (await res.json()) as { content?: unknown; usage?: unknown }
  const blocks = Array.isArray(data.content)
    ? (data.content as Array<{ type?: string; text?: string }>)
    : []
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
  reqLog.info(
    { ...req.scope, status: res.status, ms, outBytes: text.length, usage: data.usage },
    'haiku response',
  )
  return { text, usage: data.usage, ms }
}
