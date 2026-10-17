import type { VoiceOption } from '@/features/assistant/voice/speech'

// Qué voz suena menos robótica. Puro: entre las voces en español, primero las de
// mejor calidad que el sistema o el navegador marcan en el nombre (Premium,
// Enhanced/Mejorada, Natural/Neural, las de Google), después las del idioma del
// navegador.

const QUALITY: Array<[RegExp, number]> = [
  [/premium/i, 50],
  [/natural|neural/i, 45],
  [/enhanced|mejorad/i, 40],
  [/google/i, 30],
  [/siri/i, 25],
]

/** Las voces de juguete de macOS (las «Eloquence»): las más robóticas, al final. */
const NOVELTY = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i

function score(voice: VoiceOption, preferred: string): number {
  if (NOVELTY.test(voice.name)) return -10
  const quality = QUALITY.find(([pattern]) => pattern.test(voice.name))?.[1] ?? 0
  const sameLang = voice.lang.toLowerCase() === preferred.toLowerCase() ? 5 : 0
  return quality + sameLang
}

/** Las voces en español, la mejor primero. */
export function spanishVoices(voices: VoiceOption[], preferred = 'es-ES'): VoiceOption[] {
  return voices
    .filter((v) => v.lang.toLowerCase().startsWith('es'))
    .sort((a, b) => score(b, preferred) - score(a, preferred) || a.name.localeCompare(b.name))
}
