// La respuesta del asistente es texto con `código` y **negrita** ocasionales. Se
// parte en segmentos y se dibuja con `v-for` — nunca `v-html`: es salida de un
// modelo y puede citar cualquier cosa, incluido HTML.

export interface InlineSegment {
  kind: 'text' | 'code' | 'bold'
  text: string
}

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/

export function parseInline(text: string): InlineSegment[] {
  const out: InlineSegment[] = []
  for (const part of text.split(INLINE)) {
    if (!part) continue
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      out.push({ kind: 'code', text: part.slice(1, -1) })
    } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      out.push({ kind: 'bold', text: part.slice(2, -2) })
    } else {
      out.push({ kind: 'text', text: part })
    }
  }
  return out
}
