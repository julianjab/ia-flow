import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { detail, inbox, item } from '@/features/inbox/test/fixtures'

vi.mock('@/features/inbox/api', () => ({
  getTaskDetail: vi.fn().mockResolvedValue(null),
  getInbox: vi.fn(),
  getTasks: vi.fn().mockResolvedValue(null),
}))

import { useInboxStore } from '@/features/inbox/store'
import TaskDetailPanel from '@/features/inbox/TaskDetailPanel.vue'

const blocker = item({ ref: 'acme/api#2', title: 'Migrar la tabla' })
const blocked = item({ blocked_by: ['acme/api#2', 'acme/web#9'], unlocks: 3 })

function mountPanel() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useInboxStore()
  store.inbox = inbox([blocked, blocker])
  const w = mount(TaskDetailPanel, {
    props: { item: blocked, detail: { loading: false, error: null, data: detail(blocked) } },
    global: { plugins: [pinia] },
  })
  return { w, store }
}

describe('TaskDetailPanel: quién la bloquea', () => {
  it('lo que la bloquea y está en el board abre su detalle acá; lo demás va a GitHub', async () => {
    const { w, store } = mountPanel()
    await w.get('[data-test="goto-acme/api#2"]').trigger('click')
    expect(store.openRef).toBe('acme/api#2')
    expect(store.expanded).toBe(true)
    expect(w.find('[data-test="goto-acme/web#9"]').exists()).toBe(false)
    expect(w.get('.td__exec').text()).toContain('#9')
  })

  it('dice cuántas destraba', () => {
    const { w } = mountPanel()
    expect(w.get('.td__unlocks').text()).toBe('Destraba 3')
  })
})
