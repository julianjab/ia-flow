import type { AddToBoardRequest, AddToBoardResult } from '@ia-flow/shared'
import { ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { postBoardItem, postTaskStatus } from '@/features/inbox/api'
import type { ActionState } from '@/features/inbox/state/actions'

// Mover una card del board a otra columna («Mover a…» del feed) y agregar al board un issue que no
// está, firmados con el token de GitHub del usuario. Cómo terminó cada movida queda por ref, aparte
// de las acciones: el error de mover no se pega al botón de la acción de la misma fila. Vive dentro
// del store (`store.ts` la compone): `afterOk` relee la bandeja.

export interface AddState {
  result: AddToBoardResult | null
  error: string | null
}

export function createMoves(afterOk: () => Promise<void>) {
  const moves = ref<Record<string, ActionState>>({})

  function put(ref: string, state: ActionState): void {
    moves.value = { ...moves.value, [ref]: state }
  }

  /** Mueve la card. El que la llama ya consiguió el token: sin él no hay request. */
  async function moveTask(ref: string, status: string, githubToken: string): Promise<boolean> {
    put(ref, { pending: true, result: null, error: null })
    try {
      const result = await postTaskStatus(ref, status, githubToken)
      put(ref, { pending: false, result, error: null })
      if (result.ok) await afterOk()
      return result.ok
    } catch (err) {
      put(ref, { pending: false, result: null, error: extractErrorMessage(err) })
      return false
    }
  }

  function clearMove(ref: string): void {
    const { [ref]: _gone, ...rest } = moves.value
    moves.value = rest
  }

  /** Agrega el issue al board. Lo que salió (o el error legible) lo dibuja el formulario. */
  async function addToBoard(request: AddToBoardRequest, githubToken: string): Promise<AddState> {
    try {
      const result = await postBoardItem(request, githubToken)
      if (result.ok) await afterOk()
      return { result, error: null }
    } catch (err) {
      return { result: null, error: extractErrorMessage(err) }
    }
  }

  return { moves, moveTask, clearMove, addToBoard }
}
