const FORBIDDEN_UNQUOTED = new Set([';', '|', '&', '>', '<', '`', '$', '\n'])
/** Lo que una `\` escapa dentro de comillas dobles, como en POSIX sh. */
const DOUBLE_QUOTE_ESCAPABLE = new Set(['"', '\\', '$', '`'])

interface QuotedState {
  current: string
  quote: '"' | "'" | undefined
  escaping: boolean
}

/** Consume un carácter mientras hay una comilla abierta. */
function readQuoted(state: QuotedState, char: string): void {
  if (state.escaping) {
    state.escaping = false
    state.current += DOUBLE_QUOTE_ESCAPABLE.has(char) ? char : `\\${char}`
  } else if (state.quote === '"' && char === '\\') {
    state.escaping = true
  } else if (char === state.quote) {
    state.quote = undefined
  } else {
    state.current += char
  }
}

/**
 * Tokeniza un comando en argv SIN invocar un shell — soporta comillas simples/dobles. Entre
 * comillas simples el contenido viaja literal; entre dobles, como en POSIX sh, `\"`, `\\`, `\$` y
 * `` \` `` se reducen al carácter escapado y cualquier otra `\x` queda tal cual (`$`/backtick
 * entre comillas son texto: no hay expansión). Corta con un error explícito ante
 * cualquier metacarácter de shell FUERA de comillas (`;`, `|`, `&`, `>`, `<`, backtick, `$`,
 * newline). No es que esos caracteres sean peligrosos acá —`spawn` sin shell los pasaría como
 * argv literal, sin interpretarlos— sino que un modelo que los usa está esperando semántica de
 * shell (un pipe, una redirección) que `bash_run` nunca va a dar, y fallar alto ahí es mejor
 * que ejecutar silenciosamente algo distinto de lo que el modelo pidió.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = []
  const state: QuotedState = { current: '', quote: undefined, escaping: false }

  for (const char of command) {
    if (state.quote) {
      readQuoted(state, char)
      continue
    }
    if (char === '"' || char === "'") {
      state.quote = char
      continue
    }
    if (FORBIDDEN_UNQUOTED.has(char)) {
      throw new Error(
        `bash_run: "${char}" no soportado (sin shell: sin pipes/redirecciones/expansión) — comando: "${command}"`,
      )
    }
    if (/\s/.test(char)) {
      if (state.current.length > 0) {
        tokens.push(state.current)
        state.current = ''
      }
      continue
    }
    state.current += char
  }
  if (state.quote) {
    throw new Error(`bash_run: comilla ${state.quote} sin cerrar — comando: "${command}"`)
  }
  if (state.current.length > 0) tokens.push(state.current)
  return tokens
}
