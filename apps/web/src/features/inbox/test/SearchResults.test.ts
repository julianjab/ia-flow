import type { BoardRest } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getBoardRest = vi.fn()
const getTaskDetail = vi.fn()
vi.mock('@/features/inbox/api', () => ({
  getInbox: vi.fn(),
  getTasks: vi.fn(),
  getBoardRest: (...a: unknown[]) => getBoardRest(...a),
  getTaskDetail: (...a: unknown[]) => getTaskDetail(...a),
  postTaskAction: vi.fn(),
}))

import InboxSearch from '@/features/inbox/InboxSearch.vue'
import SearchResults from '@/features/inbox/SearchResults.vue'
import { useInboxStore } from '@/features/inbox/store'
import { inbox, item } from '@/features/inbox/test/fixtures'

const rest: BoardRest = {
  columns: [
    {
      status: 'Done',
      items: [
        {
          ref: 'acme/web#5',
          project_id: 'p',
          title: 'Cobro viejo',
          url: 'https://github.com/acme/web/issues/5',
          labels: [],
          updated_at: '2026-10-01T10:00:00Z',
        },
      ],
    },
  ],
}

function render() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useInboxStore()
  store.inbox = inbox([item({ ref: 'acme/web#1', title: 'Cobro mensual', group: 'need' })])
  const w = mount(
    {
      components: { InboxSearch, SearchResults },
      template: '<InboxSearch /><SearchResults v-if="store.search" />',
      setup: () => ({ store }),
    },
    {
      global: { plugins: [pinia] },
    },
  )
  return { w, store }
}

describe('el buscador de la bandeja', () => {
  beforeEach(() => {
    getBoardRest.mockReset().mockResolvedValue(rest)
    getTaskDetail.mockReset().mockResolvedValue({ item: {}, executions: [], events: [], trace: [] })
  })

  it('escribir trae el board y lista lo que coincide; tocar uno lo abre en grande', async () => {
    const { w, store } = render()
    await w.get('input').setValue('cobro')
    await flushPromises()
    expect(getBoardRest).toHaveBeenCalledOnce()
    expect(w.findAll('[data-test="hit"]').map((h) => h.text())).toEqual([
      expect.stringContaining('Cobro mensual'),
      expect.stringContaining('Cobro viejo'),
    ])
    expect(w.text()).toContain('te necesita')
    expect(w.text()).toContain('Done')
    await w.get('[data-test="hit-acme/web#5"]').trigger('click')
    expect(store.expanded).toBe(true)
    expect(store.openRef).toBe('acme/web#5')
  })

  it('una ref exacta que no está se ofrece igual, y al pie la búsqueda en GitHub', async () => {
    const { w, store } = render()
    await w.get('input').setValue('web#77')
    await flushPromises()
    expect(w.find('[data-test="hit"]').exists()).toBe(false)
    await w.get('[data-test="exact"] button').trigger('click')
    expect(store.openRef).toBe('acme/web#77')
    expect(w.get('[data-test="github"]').attributes('href')).toContain('org%3Aacme')
  })

  it('sin coincidencias lo dice; Escape vacía el campo', async () => {
    const { w, store } = render()
    await w.get('input').setValue('zzzz')
    await flushPromises()
    expect(w.text()).toContain('Nada coincide con «zzzz»')
    await w.get('input').trigger('keydown', { key: 'Escape' })
    expect(store.searchQuery).toBe('')
    expect(w.find('.sr').exists()).toBe(false)
  })
})
