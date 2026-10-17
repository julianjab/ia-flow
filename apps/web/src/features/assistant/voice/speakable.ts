// Qué de una respuesta se lee en voz alta: el texto tal como se dice, partido en
// frases (una lectura larga de una sola vez se corta sola en Chrome). Puro.

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

/** `markdown` listo para decir, en frases. */
export function spokenParts(markdown: string): string[] {
  return speakable(markdown)
    .split(/(?<=[.!?…:])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}
