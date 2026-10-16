import { type Ref, ref, watch } from 'vue'
import type { Turn } from '@/features/assistant/store'
import { readyPrefix, speakable } from '@/features/assistant/voice/speakable'
import type { Speaker } from '@/features/assistant/voice/speech'

// Lee en voz alta la respuesta que está llegando, frase por frase, sin esperar a
// que termine. Sólo la que se vio nacer (`streaming`): retomar una conversación
// guardada no la lee entera. Una pregunta nueva, cambiar de conversación o
// apagar la voz cortan lo que se estaba diciendo.

const STORAGE_KEY = 'ia-flow.assistant.read-aloud'

function load(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function save(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    // Sin storage (modo privado): la preferencia dura lo que la página.
  }
}

type Reply = Extract<Turn, { kind: 'assistant' }>

function lastReply(list: Turn[]): Reply | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const turn = list[i]
    if (turn?.kind === 'assistant') return turn
  }
  return undefined
}

export interface ReadAloud {
  supported: boolean
  enabled: Ref<boolean>
  toggle: () => void
  cancel: () => void
}

export function useReadAloud(turns: () => Turn[], speaker: Speaker | null): ReadAloud {
  const enabled = ref(speaker !== null && load())
  /** La respuesta que se está leyendo y cuánto de su texto ya se mandó a la voz. */
  let reading: { id: number; spoken: number } | null = null

  function cancel(): void {
    reading = null
    speaker?.cancel()
  }

  function toggle(): void {
    enabled.value = !enabled.value
    save(enabled.value)
    if (!enabled.value) cancel()
  }

  /** La respuesta a seguir: la que ya se leía, o una que recién empieza a llegar. */
  function follow(reply: Reply): { id: number; spoken: number } | null {
    if (reading?.id === reply.id) return reading
    if (!reply.streaming) return null
    cancel()
    return { id: reply.id, spoken: 0 }
  }

  /** Manda a la voz lo que ya se puede decir de `reply`. */
  function advance(reply: Reply, current: { id: number; spoken: number }): void {
    const pending = reply.text.slice(current.spoken)
    const cut = readyPrefix(pending, !reply.streaming)
    const say = speakable(pending.slice(0, cut))
    if (say) speaker?.speak(say)
    current.spoken += cut
    reading = reply.streaming ? current : null
  }

  watch(
    turns,
    (list) => {
      if (!speaker || !enabled.value) return
      if (reading && !list.some((t) => t.id === reading?.id)) cancel()
      const last = lastReply(list)
      const current = last && follow(last)
      if (last && current) advance(last, current)
    },
    { deep: true },
  )

  return { supported: speaker !== null, enabled, toggle, cancel }
}
