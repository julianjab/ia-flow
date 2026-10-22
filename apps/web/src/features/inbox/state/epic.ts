import type { EpicDetail } from '@ia-flow/shared'
import { ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { getEpic } from '@/features/inbox/api'

// La épica abierta (desde el chip de una tarea o «Dónde se traba cada épica») y lo que se pidió de
// cada una: sus sub-issues. Vive dentro del store (`store.ts` la compone).

export interface EpicState {
  loading: boolean
  error: string | null
  data: EpicDetail | null
}

export function createEpic() {
  const epicRef = ref<string | null>(null)
  const epics = ref<Record<string, EpicState>>({})

  function put(key: string, state: EpicState): void {
    epics.value = { ...epics.value, [key]: state }
  }

  /** Pide la épica; la ya pedida se muestra mientras se relee. */
  async function loadEpic(key: string): Promise<void> {
    const prev = epics.value[key]?.data ?? null
    put(key, { loading: true, error: null, data: prev })
    try {
      put(key, { loading: false, error: null, data: await getEpic(key) })
    } catch (err) {
      put(key, { loading: false, error: extractErrorMessage(err), data: prev })
    }
  }

  function openEpic(key: string): void {
    epicRef.value = key
    void loadEpic(key)
  }

  function closeEpic(): void {
    epicRef.value = null
  }

  return { epicRef, epics, loadEpic, openEpic, closeEpic }
}
