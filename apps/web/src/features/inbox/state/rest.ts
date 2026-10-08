import type { BoardRest } from '@ia-flow/shared'
import { ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { getBoardRest } from '@/features/inbox/api'

// El resto del board de GitHub (lo que la bandeja no muestra), por proyecto. Vive dentro del
// store (`store.ts` la compone).

export function createRest(project: () => string | null) {
  const rest = ref<BoardRest | null>(null)
  const restLoading = ref(false)
  const restError = ref<string | null>(null)

  async function loadRest(): Promise<void> {
    restLoading.value = true
    try {
      rest.value = await getBoardRest(project() ?? undefined)
      restError.value = null
    } catch (err) {
      restError.value = extractErrorMessage(err)
    } finally {
      restLoading.value = false
    }
  }

  return { rest, restLoading, restError, loadRest }
}
