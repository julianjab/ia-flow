import type {
  TaskChatAction,
  TaskChatMessage,
  TaskChatReply,
  TaskChatTaskContext,
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
 * `highlights` es la ÚNICA de las 4 acciones que este store persiste como
 * estado — y sólo de sesión, nunca en `localStorage` ni el server (ver la
 * tabla de persistencia por acción en #215). `reorder` vive en
 * `taskOrderPref.ts` (localStorage puro); `tag`/`note` los aplica
 * `TareasSection.vue` contra el server.
 */
export const useTaskChatStore = defineStore('task-chat', () => {
  const history = ref<TaskChatMessage[]>([])
  const pending = ref<TaskChatReply | null>(null)
  const busy = ref(false)
  const error = ref<string | null>(null)
  const highlights = ref<Record<string, string>>({})
  let controller: AbortController | null = null

  const pendingActionsByTask = computed<Record<string, TaskChatAction[]>>(() => {
    const out: Record<string, TaskChatAction[]> = {}
    for (const action of pending.value?.actions ?? []) {
      const taskId = action.type === 'reorder' ? undefined : action.taskId
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
    controller = new AbortController()
    try {
      const reply = await sendTaskChatMessage(
        {
          projectId: input.projectId,
          message: input.message,
          history: history.value,
          tasks: input.tasks,
        },
        { signal: controller.signal },
      )
      history.value = [
        ...history.value,
        { role: 'user', content: input.message },
        { role: 'assistant', content: reply.reply },
      ]
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
    controller?.abort()
    controller = null
  }

  return {
    history,
    pending,
    busy,
    error,
    highlights,
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
