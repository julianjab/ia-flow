import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listConversations = vi.fn()
const getConversation = vi.fn()
const deleteConversation = vi.fn()

vi.mock('../api', () => ({
  streamAssistant: async function* () {},
  executeProposal: vi.fn(),
  fetchRunner: async () => ({ projects: [], agents: [] }),
  fetchTasks: async () => [],
  listConversations: (...a: unknown[]) => listConversations(...a),
  getConversation: (...a: unknown[]) => getConversation(...a),
  deleteConversation: (...a: unknown[]) => deleteConversation(...a),
}))

import { useGithubSessionStore } from '@/stores/githubSession'
import AssistantConversations from '../AssistantConversations.vue'
import { useAssistantChatStore } from '../store'

const now = new Date()
const conv = (id: string, title: string, scope: object, updated: Date) => ({
  id,
  scope,
  agent: 'assistant',
  title,
  created_at: updated.toISOString(),
  updated_at: updated.toISOString(),
  messages: 2,
})
const list = [
  conv('c1', '¿Por qué no corrió?', { kind: 'task', ref: 'acme/api#7' }, now),
  conv(
    'c2',
    '¿Está sano el runner?',
    { kind: 'general' },
    new Date(now.getTime() - 3 * 86_400_000),
  ),
]

function render(logged = true) {
  const pinia = createPinia()
  setActivePinia(pinia)
  if (logged) useGithubSessionStore().github = { login: 'julian', token: 'gho_1' }
  return mount(AssistantConversations, { global: { plugins: [pinia] } })
}

describe('AssistantConversations', () => {
  beforeEach(() => {
    listConversations.mockReset().mockResolvedValue(list)
    getConversation.mockReset().mockImplementation(async (id: string) => ({
      ...list.find((c) => c.id === id),
      thread: [{ role: 'user', content: 'x', created_at: '', proposals: [], tasks: [] }],
    }))
    deleteConversation.mockReset().mockResolvedValue(undefined)
  })

  it('lista todas tus conversaciones por fecha, cada una con su contexto', async () => {
    const w = render()
    await flushPromises()
    expect(w.findAll('.cl__group').map((g) => g.text())).toEqual(['Hoy', 'Esta semana'])
    expect(w.text()).toContain('7 api')
    expect(w.text()).toContain('General')
  })

  it('buscar filtra por título o contexto', async () => {
    const w = render()
    await flushPromises()
    await w.get('input[type="search"]').setValue('sano')
    expect(w.findAll('.cl__row').map((r) => r.find('.cl__title').text())).toEqual([
      '¿Está sano el runner?',
    ])
  })

  it('tocar una la abre con su contexto; «Nueva» empieza de cero', async () => {
    const w = render()
    await flushPromises()
    await w.get('[data-test="conv-c1"]').trigger('click')
    await flushPromises()
    const chat = useAssistantChatStore()
    expect(chat.conversationId).toBe('c1')
    expect(chat.scope).toEqual({ kind: 'task', ref: 'acme/api#7' })
    expect(w.emitted('picked')).toBeTruthy()
    await w.get('[data-test="new"]').trigger('click')
    expect(chat.conversationId).toBeNull()
    expect(chat.turns).toEqual([])
  })

  it('sin sesión de GitHub, dice que se guardan con tu usuario', () => {
    const w = render(false)
    expect(w.text()).toContain('se guardan con tu usuario de GitHub')
    expect(listConversations).not.toHaveBeenCalled()
  })
})
