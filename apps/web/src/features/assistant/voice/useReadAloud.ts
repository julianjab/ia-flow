import { watch } from 'vue'
import type { Turn } from '@/features/assistant/store'
import { useVoiceStore } from '@/features/assistant/voice/voiceStore'

// Lee en voz alta cada respuesta que se vio llegar, cuando termina: el resumen
// para el oído si el asistente lo dio (`spoken`), si no la respuesta entera.
// Retomar una conversación guardada no la lee. Una pregunta nueva o cambiar de
// conversación cortan lo que se estaba diciendo.

const KEY = 'reply:'

export function useReadAloud(turns: () => Turn[]): void {
  const voice = useVoiceStore()
  /** Las respuestas que se vieron llegar y todavía no terminaron. */
  const arriving = new Set<number>()

  /** Cambió la conversación: lo que se decía era de la otra, y lo que llegaba ya no está. */
  function forget(ids: Set<number>): void {
    const speaking = voice.speaking?.startsWith(KEY)
      ? Number(voice.speaking.slice(KEY.length))
      : null
    if (speaking !== null && !ids.has(speaking)) voice.cancel()
    for (const id of arriving) if (!ids.has(id)) arriving.delete(id)
  }

  function follow(turn: Turn): void {
    if (turn.kind !== 'assistant') return
    if (turn.streaming) {
      if (arriving.has(turn.id)) return
      arriving.add(turn.id)
      voice.cancel()
    } else if (arriving.delete(turn.id) && turn.text) {
      voice.replied(turn.spoken ?? turn.text, `${KEY}${turn.id}`)
    }
  }

  watch(
    turns,
    (list) => {
      forget(new Set(list.map((t) => t.id)))
      for (const turn of list) follow(turn)
    },
    { deep: true },
  )
}
