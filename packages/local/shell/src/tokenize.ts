const FORBIDDEN_UNQUOTED = new Set([';', '|', '&', '>', '<', '`', '$', '\n'])

/**
 * Tokeniza un comando en argv SIN invocar un shell — soporta comillas simples/dobles (el
 * contenido entre comillas viaja literal, sin escapes), pero corta con un error explícito ante
 * cualquier metacarácter de shell FUERA de comillas (`;`, `|`, `&`, `>`, `<`, backtick, `$`,
 * newline). No es que esos caracteres sean peligrosos acá —`spawn` sin shell los pasaría como
 * argv literal, sin interpretarlos— sino que un modelo que los usa está esperando semántica de
 * shell (un pipe, una redirección) que `bash_run` nunca va a dar, y fallar alto ahí es mejor
 * que ejecutar silenciosamente algo distinto de lo que el modelo pidió.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined

  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (FORBIDDEN_UNQUOTED.has(char)) {
      throw new Error(
        `bash_run: "${char}" no soportado (sin shell: sin pipes/redirecciones/expansión) — comando: "${command}"`,
      )
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (quote) {
    throw new Error(`bash_run: comilla ${quote} sin cerrar — comando: "${command}"`)
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}
