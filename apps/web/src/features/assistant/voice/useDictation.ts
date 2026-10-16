import { onUnmounted, ref } from 'vue'
import type { Dictation } from '@/features/assistant/voice/speech'

// El dictado de la caja de pregunta: lo que se dice se suma a lo que ya estaba
// escrito, y se ve mientras se reconoce. Se corta tocando otra vez, al enviar o
// al desmontar.

export function useDictation(dictation: Dictation | null) {
  const listening = ref(false)
  const error = ref<string | null>(null)

  /** Empieza a dictar sobre `base`; `write` recibe la caja completa a medida que se reconoce. */
  function start(base: string, write: (text: string) => void): void {
    if (!dictation || listening.value) return
    error.value = null
    listening.value = true
    const head = base && !/\s$/.test(base) ? `${base} ` : base
    dictation.start({
      onText: (final, interim) => write(`${head}${final}${interim}`),
      onEnd: (failed) => {
        listening.value = false
        error.value = failed ?? null
      },
    })
  }

  function stop(): void {
    if (listening.value) dictation?.stop()
  }

  onUnmounted(stop)

  return { supported: dictation !== null, listening, error, start, stop }
}
