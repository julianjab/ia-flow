import {
  TASK_CHAT_MAX_MESSAGES,
  type TaskChatAction,
  type TaskChatMessage,
  type TaskChatReply,
  type TaskChatTaskContext,
  type TaskViewSpec,
  type ViewBlock,
} from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { sendTaskChatMessage } from '@/features/tasks/chatApi'
import { buildTaskUiContract, TASK_UI_PRIMITIVES } from '@/features/tasks/uiContract'

/** Los ids de tarea que un bloque nombra, leyendo sólo las claves que el
 *  contrato declaró como portadoras de ids (`taskIdProps`). Acepta un array o
 *  un id suelto: cuál de las dos formas usa cada primitiva lo dice su JSON
 *  Schema, no este helper. */
function taskIdsOf(block: ViewBlock, taskIdProps: string[]): string[] {
  return taskIdProps
    .flatMap((key) => {
      const value = block.props[key]
      return Array.isArray(value) ? value : [value]
    })
    .filter((id): id is string => typeof id === 'string')
}

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
  /** La vista propuesta, SEPARADA de `pending` justo porque no comparte su
   *  ciclo de vida: `discard()` tira la propuesta de cambios y esto sobrevive
   *  (ver `rowBlocksByTask`). */
  const view = ref<TaskViewSpec | null>(null)
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

  /**
   * Los bloques de slot `row` que le tocan a cada fila.
   *
   * Genérico a propósito: no sabe qué es un `row-action`, sólo que el
   * contrato declaró qué primitivas se dibujan en una fila y en qué prop
   * llevan los ids. Una primitiva de fila nueva aparece acá sin tocar el
   * store — su única línea de código propia es su renderer.
   *
   * NO se limpia con `discard()` ni depende de "Aplicar": un bloque de vista
   * no es un cambio que haya que confirmar. Vive mientras dure la
   * conversación —igual que `history`— y lo reemplaza entero el turno
   * siguiente, que es lo que hace que "sacá ese botón" funcione sin un verbo
   * aparte para deshacer.
   */
  const rowBlocksByTask = computed<Record<string, ViewBlock[]>>(() => {
    const out: Record<string, ViewBlock[]> = {}
    for (const block of view.value?.blocks ?? []) {
      const def = TASK_UI_PRIMITIVES.find((d) => d.id === block.use)
      if (def?.slot !== 'row') continue
      for (const taskId of taskIdsOf(block, def.taskIdProps)) {
        out[taskId] = [...(out[taskId] ?? []), block]
      }
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
    /** Los statuses reales del board — entran al contrato para que el modelo
     *  elija de la lista que existe y no de una inventada.
     *
     *  Opcional: si el board no los expuso (o el fetch falló), las
     *  operaciones que dependan de ellos se retiran del contrato y el resto
     *  del asistente sigue funcionando. Degradar es correcto; romper la
     *  conversación entera por un botón que no se puede ofrecer, no. */
    statuses?: string[]
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
          uiContract: buildTaskUiContract({ statuses: input.statuses ?? [] }),
        },
        { signal: controller.signal },
      )
      history.value = [
        ...history.value,
        { role: 'user' as const, content: input.message },
        { role: 'assistant' as const, content: reply.reply },
      ].slice(-TASK_CHAT_MAX_MESSAGES)
      pending.value = reply
      // Reemplazo, no merge: el turno nuevo describe la vista COMPLETA, así
      // que "sacá ese botón" es simplemente un turno que no lo incluye.
      view.value = reply.view
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
    view.value = null
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
    view,
    rowBlocksByTask,
    ask,
    stop,
    discard,
    recordHighlights,
    clearHighlight,
    reset,
  }
})
