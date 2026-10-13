/** El logger que el gateway necesita: sin contenido de mensajes, sólo metadatos de la llamada. */
export interface GatewayLog {
  info(message: string, attributes?: Record<string, string | number | boolean>): void
  warn(message: string, attributes?: Record<string, string | number | boolean>): void
  error(message: string, attributes?: Record<string, string | number | boolean>): void
}

export const NOOP_LOG: GatewayLog = { info() {}, warn() {}, error() {} }

const SECRET_HEADERS = new Set(['authorization', 'x-api-key'])

/** Enmascara una credencial: el esquema (si lo hay) y el largo, nunca el valor. */
function maskSecret(value: string): string {
  const [scheme, ...rest] = value.trim().split(/\s+/)
  return rest.length > 0 ? `${scheme} (${rest.join(' ').length} chars)` : `(${value.length} chars)`
}

/** El request que sale hacia Anthropic, legible: URL, headers con la credencial enmascarada y
 *  body completo. */
export function formatAnthropicRequest(request: {
  url: string
  headers: Record<string, string>
  body: unknown
}): string {
  const headers = Object.entries(request.headers)
    .map(
      ([name, value]) =>
        `  ${name}: ${SECRET_HEADERS.has(name.toLowerCase()) ? maskSecret(value) : value}`,
    )
    .join('\n')
  return `request hacia Anthropic\nPOST ${request.url}\n${headers}\nbody: ${JSON.stringify(request.body)}`
}
