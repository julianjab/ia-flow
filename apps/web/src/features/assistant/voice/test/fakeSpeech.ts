import { vi } from 'vitest'

// Un `speechSynthesis` de mentira para los tests: guarda lo que se dijo y deja
// terminar la lectura a mano (`finish`), como el `onend` del navegador.

export interface FakeSpeech {
  said: string[][]
  voiceOf: Array<string | undefined>
  cancel: ReturnType<typeof vi.fn>
  /** Termina de decir lo último (dispara el `onend` de su última frase). */
  finish(): void
  uninstall(): void
}

export function installFakeSpeech(voices: Array<{ name: string; lang: string }> = []): FakeSpeech {
  const g = globalThis as Record<string, unknown>
  let queue: Array<{ text: string; onend: (() => void) | null; voice?: { voiceURI: string } }> = []
  const fake: FakeSpeech = {
    said: [],
    voiceOf: [],
    cancel: vi.fn(() => {
      queue = []
    }),
    finish() {
      const last = queue.at(-1)
      queue = []
      last?.onend?.()
    },
    uninstall() {
      delete g.speechSynthesis
      delete g.SpeechSynthesisUtterance
    },
  }
  let batch: string[] | null = null
  g.SpeechSynthesisUtterance = class {
    onend: (() => void) | null = null
    lang = ''
    voice?: { voiceURI: string }
    constructor(public text: string) {}
  }
  g.speechSynthesis = {
    speak(u: { text: string; onend: (() => void) | null; voice?: { voiceURI: string } }) {
      if (queue.length === 0) {
        batch = []
        fake.said.push(batch)
        fake.voiceOf.push(u.voice?.voiceURI)
      }
      batch?.push(u.text)
      queue.push(u)
    },
    cancel: fake.cancel,
    getVoices: () =>
      voices.map((v) => ({ voiceURI: v.name, name: v.name, lang: v.lang, localService: true })),
    addEventListener() {},
  }
  return fake
}
