// La sección `## Slack` al final del cuerpo de un PR: dónde guarda el link del
// hilo de review una fuente que NO tiene un campo propio donde escribirlo
// (github-issues siempre; github-project cuando el proyecto declara
// `slackThreadField: null`).
//
// Puro y sin I/O: quien llama trae el body y publica el resultado.
//
// El bloque va delimitado por un marker HTML —misma decisión que
// `<!-- ia-flow:system-comment -->`— y no por el heading: un `## Slack` es
// texto que un humano puede escribir, y buscarlo por heading haría que el
// upsert le pise una sección que no es nuestra. El marker es invisible al
// renderizar y hace la operación idempotente: el segundo pedido REEMPLAZA el
// bloque en vez de acumular uno nuevo abajo.

const OPEN = '<!-- ia-flow:slack -->'
const CLOSE = '<!-- /ia-flow:slack -->'

const BLOCK_RE = new RegExp(`\\n*${OPEN}[\\s\\S]*?${CLOSE}`, 'g')

/** El body con el bloque `## Slack` puesto o actualizado al final. */
export function upsertSlackSection(body: string, threadUrl: string): string {
  const withoutBlock = (body ?? '').replace(BLOCK_RE, '').trimEnd()
  const block = `${OPEN}\n## Slack\n\n${threadUrl}\n${CLOSE}`
  return withoutBlock ? `${withoutBlock}\n\n${block}` : block
}

/** El link del hilo que este mismo helper escribió, si está. */
export function extractSlackThreadUrl(body: string | undefined | null): string | undefined {
  if (!body) return undefined
  const match = body.match(new RegExp(`${OPEN}([\\s\\S]*?)${CLOSE}`))
  if (!match) return undefined
  return match[1].match(/https?:\/\/\S+/)?.[0]
}
