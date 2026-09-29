/**
 * Sin `--live`, TODA escritura a GitHub se simula: las lecturas (GET y queries GraphQL) van a la
 * API real, las escrituras se imprimen y devuelven una respuesta falsa. Así se prueba el ruteo
 * completo contra issues reales sin tocar el board.
 */
function fakeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** La respuesta falsa de una escritura simulada, con la forma que espera quien la pidió. */
function simulatedResponse(url: string, method: string): Response {
  if (url.endsWith('/graphql')) return fakeResponse({ data: { simulated: true } })
  if (url.endsWith('/comments')) return fakeResponse({ html_url: '(comentario simulado)' }, 201)
  if (method === 'DELETE') return new Response(null, { status: 204 })
  return fakeResponse(url.endsWith('/labels') ? [] : {})
}

/** `fetch` que deja pasar lecturas y simula escrituras, imprimiendo cada una. */
export function simulatedWritesFetch(log: (line: string) => void): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? init.body : undefined
    const isGraphqlRead = url.endsWith('/graphql') && !body?.includes('mutation')
    if (method === 'GET' || isGraphqlRead) return fetch(input, init)

    log(
      `[simulado] ${method} ${url.replace('https://api.github.com', '')}${body ? ` ${body}` : ''}`,
    )
    return simulatedResponse(url, method)
  }) as typeof fetch
}
