import {
  TASK_CHAT_MAX_MESSAGES,
  type TaskChatAction,
  type TaskChatMessage,
  type TaskChatReply,
  type TaskChatTaskContext,
} from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { sendTaskChatMessage } from '@/features/tasks/chatApi'

/**
 * El estado de la barra de comandos del asistente — reemplaza al viejo
 * drawer (ver #215/#216). Store y no un `ref` local de `TareasSection`: la
 * fila de cada tarea necesita saber si HAY una propuesta que la involucra
 * sin que el padre le pase 40 props, y `TaskCommandBar` necesita el mismo
 * estado desde otro punto del árbol.
 *
 * Sin historial persistido: `history` vive sólo en memoria mientras la
 * sección de Tareas está montada (`reset()` en el `onUnmounted` de
 * `TareasSection.vue`) — mismo comportamiento que el drawer viejo, sin hilo
 * de conversación (ver #215).
 *
 * `highlights` es la ÚNICA de las 5 acciones que este store persiste como
 * estado — y sólo de sesión, nunca en `localStorage` (ver la tabla de
 * persistencia por acción en #215). `reorder`/`tag`/`note`/`group` viven en
 * `localStorage` puro (`taskOrderPref.ts`/`taskTagPref.ts`/`taskNotePref.ts`/
 * `taskGroupPref.ts`), aplicados por `TareasSection.vue`.
 */
export const useTaskChatStore = defineStore('task-chat', () => {
  const history = ref<TaskChatMessage[]>([])
  const pending = ref<TaskChatReply | null>(null)
  const busy = ref(false)
  const error = ref<string | null>(null)
  const highlights = ref<Record<string, string>>({})
  /** El último mensaje intentado — es lo que "reintentar" reenvía tras un
   *  fallo. Separado de `history` porque un turno fallido NUNCA se empuja
   *  ahí (ver `ask`): sin esto, `history.at(-1)` después de un fallo es el
   *  turno anterior EXITOSO, y "reintentar" reenviaría la pregunta
   *  equivocada — o, si el primer intento falla, nada en absoluto. */
  const lastAttemptedMessage = ref<string | null>(null)
  let controller: AbortController | null = null

  const pendingActionsByTask = computed<Record<string, TaskChatAction[]>>(() => {
    const out: Record<string, TaskChatAction[]> = {}
    for (const action of pending.value?.actions ?? []) {
      // `reorder`/`group` son scope de proyecto, sin `taskId` — no van en
      // ningún bucket por tarea (se resumen aparte, en `TaskCommandBar.vue`).
      const taskId =
        action.type === 'reorder' || action.type === 'group' ? undefined : action.taskId
      if (!taskId) continue
      out[taskId] = [...(out[taskId] ?? []), action]
    }
    return out
  })

  /** Sólo cuando el modelo eligió `scope: { type: 'task' }` — la respuesta
   *  de texto se expande DENTRO de la fila, no en la barra (R18). */
  const pendingReplyForTask = computed(
    () => (taskId: string) =>
      pending.value?.scope.type === 'task' && pending.value.scope.taskId === taskId
        ? pending.value.reply
        : null,
  )

  async function ask(input: {
    projectId: string
    message: string
    tasks: TaskChatTaskContext[]
  }): Promise<void> {
    busy.value = true
    error.value = null
    pending.value = null
    lastAttemptedMessage.value = input.message
    controller = new AbortController()
    try {
      const reply = await sendTaskChatMessage(
        {
          projectId: input.projectId,
          message: input.message,
          // El contrato tope a TASK_CHAT_MAX_MESSAGES (ver
          // TaskChatRequestSchema) — sin este slice, el turno 11 en
          // adelante falla la validación de Zod con un 400 permanente.
          history: history.value.slice(-TASK_CHAT_MAX_MESSAGES),
          tasks: input.tasks,
        },
        { signal: controller.signal },
      )
      history.value = [
        ...history.value,
        { role: 'user' as const, content: input.message },
        { role: 'assistant' as const, content: reply.reply },
      ].slice(-TASK_CHAT_MAX_MESSAGES)
      pending.value = reply
    } catch (e) {
      if (controller?.signal.aborted) {
        error.value = null // cancelado a propósito — no es un fallo que reportar
      } else {
        error.value = e instanceof Error ? e.message : String(e)
      }
    } finally {
      busy.value = false
      controller = null
    }
  }

  function stop(): void {
    controller?.abort()
  }

  function discard(): void {
    pending.value = null
  }

  /** Sólo actualiza el estado de sesión de `highlight` — las acciones
   *  `tag`/`note`/`reorder` de la misma propuesta las resuelve
   *  `TareasSection.vue` (server o `taskOrderPref.ts`) antes de llamar a
   *  `discard()`. Separado de `discard` para que el caller decida el orden
   *  (marcar highlights, PERSISTIR lo demás, y sólo entonces limpiar). */
  function recordHighlights(actions: TaskChatAction[]): void {
    for (const action of actions) {
      if (action.type === 'highlight') {
        highlights.value = { ...highlights.value, [action.taskId]: action.reason }
      }
    }
  }

  function clearHighlight(taskId: string): void {
    const { [taskId]: _drop, ...rest } = highlights.value
    highlights.value = rest
  }

  function reset(): void {
    history.value = []
    pending.value = null
    error.value = null
    highlights.value = {}
    lastAttemptedMessage.value = null
    controller?.abort()
    controller = null
  }

  return {
    history,
    pending,
    busy,
    error,
    highlights,
    lastAttemptedMessage,
    pendingActionsByTask,
    pendingReplyForTask,
    ask,
    stop,
    discard,
    recordHighlights,
    clearHighlight,
    reset,
  }
})
