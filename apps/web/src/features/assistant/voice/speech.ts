// El borde con el navegador: la voz que lee (`speechSynthesis`) y el oído que
// dicta (`SpeechRecognition`). Lo demás de `voice/` recibe estos puertos y no
// toca `window`; un navegador sin la API devuelve `null` y la UI no dibuja el botón.

/** Lee en voz alta, en cola: cada `speak` se dice después del anterior. */
export interface Speaker {
  speak(text: string): void
  cancel(): void
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
  return {
    speak(text) {
      const utterance = new Utterance(text)
      utterance.lang = spanish()
      synth.speak(utterance)
    },
    cancel() {
      synth.cancel()
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
