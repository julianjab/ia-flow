import type { AssistantConversation } from '@ia-flow/shared'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listConversations = vi.fn()
const getConversation = vi.fn()
const deleteConversation = vi.fn()

vi.mock('../api', () => ({
  streamAssistant: async function* () {},
  executeProposal: vi.fn(),
  fetchProjects: async () => [],
  listConversations: (...a: unknown[]) => listConversations(...a),
  getConversation: (...a: unknown[]) => getConversation(...a),
  deleteConversation: (...a: unknown[]) => deleteConversation(...a),
}))

import { useGithubSessionStore } from '@/stores/githubSession'
import { useAssistantHistoryStore } from '../historyStore'
import { useAssistantChatStore } from '../store'

const conversation: AssistantConversation = {
  id: 'c1',
  scope: { kind: 'general' },
  title: '¿está sano?',
  created_at: '2026-09-30T10:00:00Z',
  updated_at: '2026-09-30T10:00:00Z',
  messages: 2,
  thread: [
    { role: 'user', content: '¿está sano?', created_at: 'x', proposals: [], tasks: [] },
    { role: 'assistant', content: 'Sí.', created_at: 'x', proposals: [], tasks: [] },
  ],
}

describe('useAssistantHistoryStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listConversations.mockReset().mockResolvedValue([conversation])
    getConversation.mockReset().mockResolvedValue(conversation)
    deleteConversation.mockReset().mockResolvedValue(undefined)
  })

  it('sin login no hay historial: ni se pide', async () => {
    const history = useAssistantHistoryStore()
    await history.load()
    expect(history.items).toEqual([])
    expect(listConversations).not.toHaveBeenCalled()
  })

  it('con login lista todas sus conversaciones, de todos los contextos, con su token', async () => {
    useGithubSessionStore().github = { login: 'julian', token: 'gho_1' }
    const history = useAssistantHistoryStore()
    await history.load()
    expect(listConversations).toHaveBeenCalledWith(null, 'gho_1')
    expect(history.items.map((c) => c.id)).toEqual(['c1'])
  })

  it('abrir una la retoma en el chat', async () => {
    useGithubSessionStore().github = { login: 'julian', token: 'gho_1' }
    await useAssistantHistoryStore().open('c1')
    const chat = useAssistantChatStore()
    expect(chat.conversationId).toBe('c1')
    expect(chat.turns.map((t) => t.kind)).toEqual(['user', 'assistant'])
  })

  it('borrar la que está abierta la cierra', async () => {
    useGithubSessionStore().github = { login: 'julian', token: 'gho_1' }
    const history = useAssistantHistoryStore()
    await history.load()
    await history.open('c1')
    await history.remove('c1')
    expect(deleteConversation).toHaveBeenCalledWith('c1', 'gho_1')
    expect(history.items).toEqual([])
    expect(useAssistantChatStore().conversationId).toBeNull()
  })

  it('un contexto vacío retoma su última conversación guardada; uno con algo, no se toca', async () => {
    useGithubSessionStore().github = { login: 'julian', token: 'gho_1' }
    const history = useAssistantHistoryStore()
    await history.resumeLatest()
    const chat = useAssistantChatStore()
    expect(chat.conversationId).toBe('c1')
    getConversation.mockClear()
    await history.resumeLatest()
    expect(getConversation).not.toHaveBeenCalled()
  })

  it('sin login no retoma nada', async () => {
    await useAssistantHistoryStore().resumeLatest()
    expect(listConversations).not.toHaveBeenCalled()
  })

  it('un error queda para mostrarse', async () => {
    useGithubSessionStore().github = { login: 'julian', token: 'gho_1' }
    listConversations.mockRejectedValue(new Error('runner caído'))
    const history = useAssistantHistoryStore()
    await history.load()
    expect(history.error).toBe('runner caído')
  })
})
