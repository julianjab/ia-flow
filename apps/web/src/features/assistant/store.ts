import type { AssistantChatMessage } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchAssistantMessages, postAssistantMessage } from './api.js'

function newSessionId(): string {
  return crypto.randomUUID()
}

export const useAssistantStore = defineStore('assistant', () => {
  const isOpen = ref(false)
  const sessionId = ref(newSessionId())
  const messages = ref<AssistantChatMessage[]>([])
  const sending = ref(false)
  // `true` mientras se espera la respuesta del agente por WS — no hay un
  // "terminó" explícito del lado del server (es fire-and-forget), así que se
  // apaga en cuanto llega CUALQUIER mensaje del asistente para esta sesión.
  const waitingReply = ref(false)

  const hasMessages = computed(() => messages.value.length > 0)

  function toggle() {
    isOpen.value = !isOpen.value
  }

  async function hydrate() {
    try {
      messages.value = await fetchAssistantMessages(sessionId.value)
    } catch {
      // Sesión nueva o server sin historial todavía — no es un error visible.
      messages.value = []
    }
  }

  async function send(text: string, ctx: { projectId?: string; taskId?: string } = {}) {
    const trimmed = text.trim()
    if (!trimmed || sending.value) return
    sending.value = true
    waitingReply.value = true
    // Optimista: el mensaje del operador se ve al toque, no espera al
    // roundtrip — la ruta lo persiste igual del lado del server.
    messages.value = [
      ...messages.value,
      {
        id: crypto.randomUUID(),
        sessionId: sessionId.value,
        author: 'user',
        body: trimmed,
        createdAt: new Date().toISOString(),
      },
    ]
    try {
      await postAssistantMessage({ sessionId: sessionId.value, text: trimmed, ...ctx })
    } finally {
      sending.value = false
    }
  }

  /** Llamado desde el listener de WS (ver AssistantBubble.vue) cuando llega
   *  `assistant:message` para ESTA sesión. */
  function receive(message: AssistantChatMessage) {
    if (message.sessionId !== sessionId.value) return
    messages.value = [...messages.value, message]
    waitingReply.value = false
  }

  /** `/clear` — sesión nueva, historial vacío. La vieja no se borra del
   *  server: su fila envejece sola (ver el diseño de esta feature). */
  function clear() {
    sessionId.value = newSessionId()
    messages.value = []
    waitingReply.value = false
  }

  return {
    isOpen,
    sessionId,
    messages,
    sending,
    waitingReply,
    hasMessages,
    toggle,
    hydrate,
    send,
    receive,
    clear,
  }
})
