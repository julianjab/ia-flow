import { vi } from 'vitest'

// Un `speechSynthesis` de mentira para los tests: guarda lo que se dijo y deja
// terminar la lectura a mano (`finish`), como el `onend` del navegador.

export interface FakeSpeech {
  said: string[][]
  voiceOf: Array<string | undefined>
  rateOf: number[]
  cancel: ReturnType<typeof vi.fn>
  /** Termina de decir lo último (dispara el `onend` de su última frase). */
  finish(): void
  /** Termina la frase que se está diciendo y empieza la siguiente. */
  next(): void
  uninstall(): void
}

export function installFakeSpeech(voices: Array<{ name: string; lang: string }> = []): FakeSpeech {
  const g = globalThis as Record<string, unknown>
  type Utterance = {
    text: string
    onstart: (() => void) | null
    onend: (() => void) | null
    voice?: { voiceURI: string }
    rate: number
  }
  let queue: Utterance[] = []
  const fake: FakeSpeech = {
    said: [],
    voiceOf: [],
    rateOf: [],
    cancel: vi.fn(() => {
      queue = []
    }),
    finish() {
      const last = queue.at(-1)
      queue = []
      last?.onend?.()
    },
    next() {
      queue.shift()?.onend?.()
      queue[0]?.onstart?.()
    },
    uninstall() {
      delete g.speechSynthesis
      delete g.SpeechSynthesisUtterance
    },
  }
  let batch: string[] | null = null
  g.SpeechSynthesisUtterance = class {
    onstart: (() => void) | null = null
    onend: (() => void) | null = null
    lang = ''
    voice?: { voiceURI: string }
    rate = 1
    constructor(public text: string) {}
  }
  g.speechSynthesis = {
    speak(u: Utterance) {
      if (queue.length === 0) {
        batch = []
        fake.said.push(batch)
        fake.voiceOf.push(u.voice?.voiceURI)
        fake.rateOf.push(u.rate)
        queue.push(u)
        batch.push(u.text)
        u.onstart?.()
        return
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
