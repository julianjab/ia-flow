import type { BoardRest, BoardRestItem } from '@ia-flow/shared'
import { ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { getBoardRest, getClosedCards } from '@/features/inbox/api'

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

  /** Las cerradas: se piden al abrir «Cerrados» (no hacen falta para la bandeja). */
  const closed = ref<BoardRestItem[] | null>(null)
  const closedLoading = ref(false)
  const closedError = ref<string | null>(null)

  async function loadClosed(): Promise<void> {
    closedLoading.value = true
    try {
      closed.value = await getClosedCards(project() ?? undefined)
      closedError.value = null
    } catch (err) {
      closedError.value = extractErrorMessage(err)
    } finally {
      closedLoading.value = false
    }
  }

  return { rest, restLoading, restError, loadRest, closed, closedLoading, closedError, loadClosed }
}
