import type { TaskAction, TaskActionResult } from '@ia-flow/shared'
import { ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { postTaskAction } from '@/features/inbox/api'

// Las acciones sobre las tareas y cómo terminó cada una (por ref), firmadas con el token de GitHub
// del usuario. Vive dentro del store (`store.ts` la compone): `afterOk` es lo que el store hace
// cuando una salió bien (refrescar la bandeja y el detalle abierto).

export interface ActionState {
  pending: boolean
  result: TaskActionResult | null
  error: string | null
}

export function createActions(afterOk: (ref: string) => Promise<void>) {
  const actions = ref<Record<string, ActionState>>({})

  function put(ref: string, state: ActionState): void {
    actions.value = { ...actions.value, [ref]: state }
  }

  /** Ejecuta una acción. El que la llama ya verificó que hay sesión: sin token no hay request. */
  async function runAction(
    ref: string,
    action: TaskAction,
    githubToken: string,
    comment?: string,
  ): Promise<TaskActionResult | null> {
    put(ref, { pending: true, result: null, error: null })
    try {
      const body = { action, ...(comment ? { comment } : {}) }
      const result = await postTaskAction(ref, body, githubToken)
      put(ref, { pending: false, result, error: null })
      if (result.ok) await afterOk(ref)
      return result
    } catch (err) {
      put(ref, { pending: false, result: null, error: extractErrorMessage(err) })
      return null
    }
  }

  /**
   * La acción de un grupo («Mergear los 2…»): la misma acción sobre cada tarea, en serie. Corta en
   * la primera que falla: su error queda en `actions[ref]`, pegado a su botón.
   */
  async function runActionSeries(
    refs: readonly string[],
    action: TaskAction,
    githubToken: string,
  ): Promise<boolean> {
    for (const ref of refs) {
      const result = await runAction(ref, action, githubToken)
      if (!result?.ok) return false
    }
    return true
  }

  function clearAction(ref: string): void {
    const { [ref]: _gone, ...rest } = actions.value
    actions.value = rest
  }

  return { actions, runAction, runActionSeries, clearAction }
}
