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
  /** Una pregunta ya escrita afuera (la caja del detalle de una tarea): el panel la manda al abrir. */
  const message = ref<string | null>(null)
  /** Una respuesta terminó con el asistente cerrado: la marca quien lo abre (burbuja o pestaña). */
  const unread = ref(false)
  /**
   * Un tema con contexto propio (una mejora y su «¿Por qué?»): arranca una conversación nueva, se
   * dice de qué es (`title`) y `context` viaja delante de la primera pregunta sin mostrarse —el
   * asistente lo lee, quien pregunta no lo tiene que pegar—.
   */
  const topic = ref<{ title: string; context: string } | null>(null)

  function open(
    scope?: AssistantScope,
    question?: string,
    about?: { title: string; context: string },
  ): void {
    if (scope) request.value = scope
    if (about) topic.value = about
    if (question?.trim()) message.value = question.trim()
    isOpen.value = true
    unread.value = false
  }

  function consumeTopic(): { title: string; context: string } | null {
    const about = topic.value
    topic.value = null
    return about
  }

  function close(): void {
    isOpen.value = false
  }

  function consumeRequest(): AssistantScope | null {
    const scope = request.value
    request.value = null
    return scope
  }

  function consumeMessage(): string | null {
    const text = message.value
    message.value = null
    return text
  }

  return {
    isOpen,
    request,
    message,
    unread,
    topic,
    open,
    close,
    consumeRequest,
    consumeMessage,
    consumeTopic,
  }
})
