// Qué de una respuesta se lee en voz alta, y cuándo. Puro: el texto entra a
// medida que llega el stream y sale en frases completas, sin código ni tablas.

const FENCE = '```'
const SENTENCE_END = new Set(['.', '!', '?', '…', ':'])

/**
 * Hasta dónde se puede leer `buffer` sin cortar una frase a la mitad ni entrar a
 * un bloque de código abierto: la última frase completa (cierra con `.`, `!`, `?`,
 * `…` o `:` seguido de un espacio, o con un salto de línea) o el cierre de un
 * bloque de código. Con `final`, todo.
 */
export function readyPrefix(buffer: string, final: boolean): number {
  if (final) return buffer.length
  let cut = 0
  let inFence = false
  for (let i = 0; i < buffer.length; i++) {
    if (buffer.startsWith(FENCE, i)) {
      inFence = !inFence
      i += FENCE.length - 1
      if (!inFence) cut = i + 1
      continue
    }
    if (inFence) continue
    const c = buffer[i] as string
    if (c === '\n' || (SENTENCE_END.has(c) && /\s/.test(buffer[i + 1] ?? ''))) cut = i + 1
  }
  return cut
}

/** El texto tal como se dice: sin bloques de código, tablas ni marcas de markdown; un link es «el enlace». */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line))
    .map((line) => line.replace(/^\s*(#{1,6}|[-*•]|\d+[.)])\s+/, ''))
    .join('\n')
    .replace(/https?:\/\/\S+/g, 'el enlace')
    .replace(/[`*~]/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
