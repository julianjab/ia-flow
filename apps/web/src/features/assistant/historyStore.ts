import type { AssistantConversationSummary } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { deleteConversation, getConversation, listConversations } from '@/features/assistant/api'
import { useAssistantChatStore } from '@/features/assistant/store'
import { useGithubSessionStore } from '@/stores/githubSession'

// Las conversaciones guardadas del contexto actual, de quien tiene la sesión de
// GitHub: listarlas, retomar una (la carga en el chat) y borrarla. Sin login no
// hay historial, y la lista queda vacía.

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
      items.value = await listConversations(chat.scope, github.token)
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

  return { items, loading, error, load, open, remove }
})
