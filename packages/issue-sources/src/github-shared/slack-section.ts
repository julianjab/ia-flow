// La sección `## Slack` de un cuerpo de GitHub: dónde guarda el link del hilo
// de review una fuente que NO tiene un campo propio donde escribirlo
// (github-issues siempre; github-project cuando el proyecto declara
// `slackThreadField: null`).
//
// El cuerpo puede ser el de un PR o el de un issue: el helper no lo sabe ni le
// importa. `github-issues` escribe en los dos —el issue es el canónico porque
// se lee gratis del scan, el PR es la copia que ve quien lo abre— y por eso
// esto vive en `github-shared` y no colgado del módulo del PR.
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
  const withoutBlock = stripSlackSection(body)
  const block = `${OPEN}\n## Slack\n\n${threadUrl}\n${CLOSE}`
  return withoutBlock ? `${withoutBlock}\n\n${block}` : block
}

/** El body sin el bloque — lo que ve un agente cuando lee la descripción. */
export function stripSlackSection(body: string | undefined | null): string {
  return (body ?? '').replace(BLOCK_RE, '').trimEnd()
}

/** El link del hilo que este mismo helper escribió, si está. */
export function extractSlackThreadUrl(body: string | undefined | null): string | undefined {
  if (!body) return undefined
  const match = body.match(new RegExp(`${OPEN}([\\s\\S]*?)${CLOSE}`))
  if (!match) return undefined
  return match[1].match(/https?:\/\/\S+/)?.[0]
}

/**
 * El body nuevo con el bloque del viejo re-adjuntado, si el nuevo no trae uno.
 *
 * Existe porque el cuerpo del issue tiene DOS dueños: el link del hilo lo
 * escribe `setSlackThreadUrl`, y el PRD lo reescribe entero un agente
 * (`saveOutput`) o el editor de tareas. Sin esto, el primer refinamiento
 * posterior a un pedido de review borraba el link y el próximo pedido abría un
 * hilo nuevo.
 *
 * Gana el bloque del body nuevo cuando lo trae: quien escribe explícitamente un
 * link está diciendo cuál es, y pisarlo con el viejo sería ignorar la escritura.
 */
export function preserveSlackSection(
  previousBody: string | undefined | null,
  nextBody: string,
): string {
  if (extractSlackThreadUrl(nextBody)) return nextBody
  const previous = extractSlackThreadUrl(previousBody)
  return previous ? upsertSlackSection(nextBody, previous) : nextBody
}
