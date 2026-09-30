import type { AssistantConversationSummary } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { deleteConversation, getConversation, listConversations } from '@/features/assistant/api'
import { useAssistantChatStore } from '@/features/assistant/store'
import { useGithubSessionStore } from '@/stores/githubSession'

// Las conversaciones guardadas de quien tiene la sesión de GitHub, de todos los
// contextos: el menú lateral del asistente. Listarlas, retomar una (la carga en
// el chat, con su contexto) y borrarla. Sin login no hay historial.

export const useAssistantHistoryStore = defineStore('assistant-history', () => {
  const chat = useAssistantChatStore()
  const session = useGithubSessionStore()

  const items = ref<AssistantConversationSummary[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function load(): Promise<void> {
    const github = session.github
    if (!github) {
      items.value = []
      return
    }
    loading.value = true
    try {
      items.value = await listConversations(null, github.token)
      error.value = null
    } catch (err) {
      error.value = extractErrorMessage(err)
    } finally {
      loading.value = false
    }
  }

  async function open(id: string): Promise<void> {
    const github = session.github
    if (!github) return
    try {
      chat.resume(await getConversation(id, github.token))
      error.value = null
    } catch (err) {
      error.value = extractErrorMessage(err)
    }
  }

  async function remove(id: string): Promise<void> {
    const github = session.github
    if (!github) return
    try {
      await deleteConversation(id, github.token)
      items.value = items.value.filter((c) => c.id !== id)
      // Borrar la que está abierta la cierra: lo que sigue sería otra conversación.
      if (chat.conversationId === id) chat.newConversation()
      error.value = null
    } catch (err) {
      error.value = extractErrorMessage(err)
    }
  }

  /** Un contexto que se abre vacío retoma su última conversación guardada (con login): lo que se
   *  preguntó sobre esta tarea no se pierde al recargar o al volver a ella. */
  async function resumeLatest(): Promise<void> {
    const github = session.github
    if (!github || chat.turns.length || chat.streaming) return
    const scope = chat.scope
    try {
      const [latest] = await listConversations(scope, github.token)
      // Mientras tanto se pudo cambiar de contexto o empezar a escribir: no se pisa nada.
      if (latest && !chat.turns.length && chat.scope === scope) await open(latest.id)
    } catch {
      // Sin historial a mano, el chat arranca vacío como siempre.
    }
  }

  return { items, loading, error, load, open, remove, resumeLatest }
})
