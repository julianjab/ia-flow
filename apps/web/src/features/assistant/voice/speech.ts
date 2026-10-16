// El borde con el navegador: la voz que lee (`speechSynthesis`) y el oído que
// dicta (`SpeechRecognition`). Lo demás de `voice/` recibe estos puertos y no
// toca `window`; un navegador sin la API devuelve `null` y la UI no dibuja el botón.

/** Una voz del sistema o del navegador. */
export interface VoiceOption {
  id: string
  name: string
  lang: string
  /** Del equipo (sin red); las de red (Google, las «Natural» de Edge) suelen sonar mejor. */
  local: boolean
}

/** Con qué voz y a qué velocidad se lee (`rate` 1 es la normal). */
export interface SpeakOptions {
  voiceId: string | null
  rate: number
}

/** Lee en voz alta. `speak` corta lo que se estaba diciendo; `onDone` llega al terminar de decir
 *  todo (no si se cortó). */
export interface Speaker {
  speak(parts: string[], options: SpeakOptions, onDone?: () => void): void
  cancel(): void
  voices(): VoiceOption[]
  /** Las voces llegan tarde en algunos navegadores: avisa cuando cambian. */
  onVoices(listener: () => void): void
}

/** Dicta: `onText` recibe lo ya firme y lo que todavía se está reconociendo. */
export interface Dictation {
  start(handlers: {
    onText: (final: string, interim: string) => void
    onEnd: (error?: string) => void
  }): void
  stop(): void
}

/** El idioma de la voz: el del navegador si es español, si no el de España. */
function spanish(): string {
  const lang = globalThis.navigator?.language ?? ''
  return lang.toLowerCase().startsWith('es') ? lang : 'es-ES'
}

export function browserSpeaker(): Speaker | null {
  const synth = globalThis.speechSynthesis
  const Utterance = globalThis.SpeechSynthesisUtterance
  if (!synth || !Utterance) return null
  /** Sube con cada `speak`/`cancel`: el `onend` de una lectura cortada no avisa. */
  let turn = 0
  return {
    speak(parts, { voiceId, rate }, onDone) {
      turn++
      synth.cancel()
      const mine = turn
      const voice = synth.getVoices().find((v) => v.voiceURI === voiceId)
      parts.forEach((part, i) => {
        const utterance = new Utterance(part)
        utterance.lang = voice?.lang ?? spanish()
        if (voice) utterance.voice = voice
        utterance.rate = rate
        if (i === parts.length - 1) {
          utterance.onend = () => {
            if (mine === turn) onDone?.()
          }
        }
        synth.speak(utterance)
      })
      if (parts.length === 0) onDone?.()
    },
    cancel() {
      turn++
      synth.cancel()
    },
    voices() {
      return synth
        .getVoices()
        .map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, local: v.localService }))
    },
    onVoices(listener) {
      synth.addEventListener?.('voiceschanged', listener)
    },
  }
}

/** Lo mínimo de `SpeechRecognition` que se usa (los tipos del DOM todavía no lo traen). */
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult:
    | ((e: {
        resultIndex: number
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
      }) => void)
    | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Sin permiso para usar el micrófono.',
  'service-not-allowed': 'Sin permiso para usar el micrófono.',
  'audio-capture': 'No se encontró un micrófono.',
  network: 'El dictado necesita conexión.',
}

export function browserDictation(): Dictation | null {
  const g = globalThis as {
    SpeechRecognition?: new () => Recognition
    webkitSpeechRecognition?: new () => Recognition
  }
  const Ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition
  // En la app de escritorio (Electron) la API existe pero sin el servicio de Google detrás:
  // falla siempre con `network`. Ahí no se ofrece.
  if (!Ctor || 'iaFlowDesktop' in globalThis) return null
  let current: Recognition | null = null
  return {
    start({ onText, onEnd }) {
      const rec = new Ctor()
      rec.lang = spanish()
      rec.continuous = true
      rec.interimResults = true
      let final = ''
      let error: string | undefined
      rec.onresult = (e) => {
        let interim = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i]
          const transcript = result?.[0]?.transcript ?? ''
          if (result?.isFinal) final += transcript
          else interim += transcript
        }
        onText(final, interim)
      }
      rec.onerror = (e) => {
        // `aborted` y `no-speech` no son fallas: se cortó o no se dijo nada.
        if (e.error !== 'aborted' && e.error !== 'no-speech')
          error = ERRORS[e.error] ?? `El dictado falló (${e.error}).`
      }
      rec.onend = () => {
        if (current === rec) current = null
        onEnd(error)
      }
      current = rec
      rec.start()
    },
    stop() {
      current?.stop()
    },
  }
}
