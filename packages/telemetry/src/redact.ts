/**
 * Lo que un log de debug puede cargar sin filtrar credenciales: una copia del valor con los
 * secretos tapados. Dos redes, porque un secreto llega de dos formas:
 *
 *   - por su CLAVE (`authorization`, `x-api-key`, `authorization_token` de un `mcp_servers`…):
 *     se tapa el valor entero, sea lo que sea;
 *   - DENTRO de un texto (un `tool_result` que imprimió un `.env`, un `Bearer …` en un comando):
 *     se tapa sólo el token, reconocido por su formato.
 *
 * Las claves de conteo (`max_tokens`, `input_tokens`, `budget_tokens`) NO son secretos: el patrón
 * pide `token` sin la `s` final.
 */

export const REDACTED = '[REDACTED]'

const SECRET_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|token|password|passwd|secret|private[-_]?key)$|[-_](token|secret|password|api[-_]?key|private[-_]?key)$/i

/** Formatos de token conocidos. El prefijo queda a la vista para saber QUÉ se tapó. */
const SECRET_VALUES: RegExp[] = [
  /\b(sk-ant-[a-z0-9]+-)[A-Za-z0-9_-]{8,}/g,
  /\b(sk-)[A-Za-z0-9_-]{20,}/g,
  /\b(gh[pousr]_)[A-Za-z0-9]{20,}/g,
  /\b(github_pat_)[A-Za-z0-9_]{20,}/g,
  /\b(xox[abposr]-)[A-Za-z0-9-]{10,}/g,
  /\b(xapp-)[A-Za-z0-9-]{10,}/g,
  /\b(AKIA)[A-Z0-9]{16}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(?=-----END [A-Z ]*PRIVATE KEY-----)/g,
]

function redactString(text: string): string {
  let out = text
  for (const pattern of SECRET_VALUES) out = out.replace(pattern, `$1${REDACTED}`)
  return out
}

/** Una copia de `value` con los secretos tapados — el original no se toca. */
export function redactSecrets<T>(value: T): T {
  return redact(value, new WeakSet()) as T
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value)
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, seen))
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    out[key] =
      SECRET_KEY.test(key) && inner != null && inner !== '' ? REDACTED : redact(inner, seen)
  }
  return out
}
