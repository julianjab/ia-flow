import { onUnmounted, ref } from 'vue'
import { SILENCE_MS, withoutSendWord } from '@/features/assistant/voice/command'
import type { Dictation } from '@/features/assistant/voice/speech'

// El dictado de la caja de pregunta: lo que se dice se suma a lo que ya estaba
// escrito, y se ve mientras se reconoce. Terminar con «enviar» (o «listo») manda
// la pregunta; 4 s callado también, si se dijo algo (si no, sólo apaga el
// micrófono). Se corta tocando otra vez, al enviar o al desmontar.

export interface DictationTarget {
  /** La caja completa, a medida que se reconoce. */
  write: (text: string) => void
  /** Manda la pregunta (ya escrita en la caja). */
  send: (text: string) => void
}

export function useDictation(dictation: Dictation | null) {
  const listening = ref(false)
  const error = ref<string | null>(null)
  let silence: ReturnType<typeof setTimeout> | undefined

  function stop(): void {
    clearTimeout(silence)
    if (listening.value) dictation?.stop()
  }

  /** Empieza a dictar sobre `base`. */
  function start(base: string, target: DictationTarget): void {
    if (!dictation || listening.value) return
    error.value = null
    listening.value = true
    const head = base && !/\s$/.test(base) ? `${base} ` : base
    let spoken = ''
    /** Ya se envió o se cortó: lo que el reconocedor mande tarde no vuelve a la caja. */
    let closed = false

    const finish = (text: string) => {
      closed = true
      stop()
      target.write(text)
      if (text.trim()) target.send(text)
    }
    const quiet = () => {
      clearTimeout(silence)
      silence = setTimeout(
        () => (spoken.trim() ? finish(`${head}${spoken}`.trim()) : stop()),
        SILENCE_MS,
      )
    }

    dictation.start({
      onText: (final, interim) => {
        if (closed) return
        spoken = `${final}${interim}`
        const text = `${head}${spoken}`
        const command = withoutSendWord(text)
        if (command === null) {
          target.write(text)
          quiet()
        } else finish(command)
      },
      onEnd: (failed) => {
        closed = true
        clearTimeout(silence)
        listening.value = false
        error.value = failed ?? null
      },
    })
    quiet()
  }

  onUnmounted(stop)

  return { supported: dictation !== null, listening, error, start, stop }
}
