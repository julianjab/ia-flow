import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listConversations = vi.fn()
const deleteConversation = vi.fn()

vi.mock('../api', () => ({
  streamAssistant: async function* () {},
  executeProposal: vi.fn(),
  fetchProjects: async () => [],
  listConversations: (...a: unknown[]) => listConversations(...a),
  getConversation: vi.fn(),
  deleteConversation: (...a: unknown[]) => deleteConversation(...a),
}))

import { useGithubSessionStore } from '@/stores/githubSession'
import AssistantHistory from '../AssistantHistory.vue'

const summary = {
  id: 'c1',
  scope: { kind: 'general' as const },
  title: '¿está sano el runner?',
  created_at: '2026-09-30T10:00:00Z',
  updated_at: '2026-09-30T10:00:00Z',
  messages: 4,
}

function render(logged: boolean) {
  const pinia = createPinia()
  setActivePinia(pinia)
  if (logged) useGithubSessionStore().github = { login: 'julian', token: 'gho_1' }
  return mount(AssistantHistory, { global: { plugins: [pinia] } })
}

describe('AssistantHistory', () => {
  beforeEach(() => {
    localStorage.clear()
    listConversations.mockReset().mockResolvedValue([summary])
    deleteConversation.mockReset().mockResolvedValue(undefined)
  })

  it('sin login avisa que no se guarda y ofrece entrar', () => {
    const w = render(false)
    expect(w.text()).toContain('no se guarda')
    expect(w.find('[data-test="toggle"]').exists()).toBe(false)
  })

  it('con login, «Anteriores» lista las del contexto', async () => {
    const w = render(true)
    await w.get('[data-test="toggle"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('¿está sano el runner?')
    expect(w.text()).toContain('2 preguntas')
  })

  it('borrar pide confirmar en la misma fila', async () => {
    const w = render(true)
    await w.get('[data-test="toggle"]').trigger('click')
    await flushPromises()
    await w.get('[data-test="delete-c1"]').trigger('click')
    expect(deleteConversation).not.toHaveBeenCalled()
    await w.get('[data-test="confirm-delete"]').trigger('click')
    await flushPromises()
    expect(deleteConversation).toHaveBeenCalledWith('c1', 'gho_1')
    expect(w.text()).toContain('Todavía no hay conversaciones guardadas')
  })
})
