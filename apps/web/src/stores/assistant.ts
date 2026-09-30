import type { AssistantScope } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'

// Vive en `stores/`, no en `features/assistant/`, a propósito: la bandeja tiene
// que abrir el asistente ya apuntado a una tarea (`open({ kind: 'task', ... })`)
// desde SU feature, y feature → feature está prohibido. `features/assistant/`
// sigue siendo dueña de la UI, la conversación y el stream — esto es sólo el
// estado de "está abierto y con qué contexto se pidió", como `stores/toast.ts`.

export const useAssistantStore = defineStore('assistant', () => {
  const isOpen = ref(false)
  /**
   * El contexto que pidió quien abrió el asistente, hasta que el panel lo
   * consume (`consumeRequest`). Se consume y no se conserva: reabrir el drawer
   * a mano no debe volver a fijar el contexto de la última vez.
   */
  const request = ref<AssistantScope | null>(null)

  function open(scope?: AssistantScope): void {
    if (scope) request.value = scope
    isOpen.value = true
  }

  function close(): void {
    isOpen.value = false
  }

  function consumeRequest(): AssistantScope | null {
    const scope = request.value
    request.value = null
    return scope
  }

  return { isOpen, request, open, close, consumeRequest }
})
