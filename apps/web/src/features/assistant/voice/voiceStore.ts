import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { spokenParts } from '@/features/assistant/voice/speakable'
import { browserDictation, browserSpeaker } from '@/features/assistant/voice/speech'
import { spanishVoices } from '@/features/assistant/voice/voices'

// La voz del asistente: si lee las respuestas, si está en modo charla (lee y
// vuelve a escuchar), con qué voz y a qué velocidad, y qué se está diciendo ahora.
// La lectura, la voz y la velocidad quedan en este navegador; la charla se prende
// a propósito cada vez.

const READ_KEY = 'ia-flow.assistant.read-aloud'
const VOICE_KEY = 'ia-flow.assistant.voice'
const RATE_KEY = 'ia-flow.assistant.rate'

/** Las velocidades que se ofrecen (1 es la normal de la voz). */
export const RATES = [1, 1.25, 1.5] as const

function loadRate(): number {
  const rate = Number(load(RATE_KEY))
  return (RATES as readonly number[]).includes(rate) ? rate : 1
}

function load(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function save(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Sin storage (modo privado): dura lo que la página.
  }
}

export const useVoiceStore = defineStore('assistant-voice', () => {
  const speaker = browserSpeaker()
  const canListen = browserDictation() !== null

  const read = ref(speaker !== null && load(READ_KEY) === '1')
  const talk = ref(false)
  const voiceId = ref<string | null>(load(VOICE_KEY))
  const rate = ref(loadRate())
  const voices = ref(spanishVoices(speaker?.voices() ?? [], globalThis.navigator?.language))
  /** Qué se está diciendo (la clave que pasó quien lo pidió), o `null`. */
  const speaking = ref<string | null>(null)
  /** Sube cuando la charla pide volver a escuchar: la caja de pregunta lo sigue. */
  const listenTick = ref(0)

  const supported = speaker !== null
  const talkSupported = supported && canListen
  /** Si el pedido lleva `voice`: el asistente suma el resumen para el oído. */
  const wantsSpeech = computed(() => read.value || talk.value)
  /** La voz con la que se lee: la elegida si sigue estando, si no la mejor. */
  const voice = computed(
    () => voices.value.find((v) => v.id === voiceId.value) ?? voices.value[0] ?? null,
  )

  speaker?.onVoices(() => {
    voices.value = spanishVoices(speaker.voices(), globalThis.navigator?.language)
  })

  /** Lo que se está leyendo, para retomarlo desde la frase actual si cambia la velocidad. */
  let reading: { parts: string[]; at: number; done: () => void } | null = null

  function speak(parts: string[], done: () => void): void {
    if (!speaker) return
    const current = { parts, at: 0, done }
    reading = current
    speaker.speak(
      parts,
      {
        voiceId: voice.value?.id ?? null,
        rate: rate.value,
        onPart: (i) => {
          current.at = i
        },
      },
      done,
    )
  }

  function say(markdown: string, key: string, after?: () => void): void {
    if (!speaker) return
    speaking.value = key
    speak(spokenParts(markdown), () => {
      reading = null
      speaking.value = null
      after?.()
    })
  }

  function cancel(): void {
    speaker?.cancel()
    reading = null
    speaking.value = null
  }

  /** Una respuesta que terminó de llegar: se lee si la voz está prendida y, en charla, se vuelve a escuchar. */
  function replied(text: string, key: string): void {
    if (!wantsSpeech.value) return
    // Se mira `talk` al terminar de leer, no al empezar: si se apagó mientras leía, no se abre el micrófono.
    say(text, key, () => {
      if (talk.value) listenTick.value++
    })
  }

  function toggleRead(): void {
    read.value = !read.value
    save(READ_KEY, read.value ? '1' : '0')
    if (!read.value && !talk.value) cancel()
  }

  /** Charla: escucha ya y, después de cada respuesta, la lee y vuelve a escuchar. */
  function toggleTalk(): void {
    talk.value = !talk.value
    if (talk.value) {
      cancel()
      listenTick.value++
    }
  }

  function chooseVoice(id: string): void {
    voiceId.value = id
    save(VOICE_KEY, id)
  }

  /** La siguiente velocidad (después de la última, la normal). Lo que se está leyendo sigue, a la
   *  velocidad nueva, desde el principio de la frase actual: una frase ya empezada no cambia de velocidad. */
  function nextRate(): void {
    const i = (RATES as readonly number[]).indexOf(rate.value)
    rate.value = RATES[(i + 1) % RATES.length] ?? 1
    save(RATE_KEY, String(rate.value))
    if (reading) speak(reading.parts.slice(reading.at), reading.done)
  }

  /** Una velocidad elegida de la lista (el sheet de voz las muestra todas). */
  function setRate(next: (typeof RATES)[number]): void {
    if (next === rate.value) return
    rate.value = next
    save(RATE_KEY, String(next))
    if (reading) speak(reading.parts.slice(reading.at), reading.done)
  }

  return {
    supported,
    talkSupported,
    read,
    talk,
    voices,
    voice,
    rate,
    speaking,
    listenTick,
    wantsSpeech,
    say,
    cancel,
    replied,
    toggleRead,
    toggleTalk,
    chooseVoice,
    nextRate,
    setRate,
  }
})
