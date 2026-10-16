// La palabra que envía lo dictado: terminar con «enviar» (o «listo», «mandar»…)
// manda la pregunta sin tocar nada. Puro; el menubar repite la misma lista
// (`apps/menubar/Voice.swift`, `DictationCommand`).

const SEND_WORDS = ['enviar', 'envia', 'envialo', 'mandar', 'manda', 'mandalo', 'listo']

/** Cuánto silencio, después de hablar, manda lo dictado (sin nada dicho, sólo apaga el micrófono). */
export const SILENCE_MS = 4000

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Si `text` termina en una palabra de envío: el texto sin ella. Si no, `null`. */
export function withoutSendWord(text: string): string | null {
  const match = /(^|\s)(\p{L}+)[\s.,;!¡?¿]*$/u.exec(text)
  if (!match?.[2] || !SEND_WORDS.includes(fold(match[2]))) return null
  return text
    .slice(0, match.index + (match[1]?.length ?? 0))
    .replace(/[\s,;:]+$/, '')
    .trim()
}
