import type { InboxItem } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { item } from '@/features/inbox/test/fixtures'

// «Lo primero» y «Después» se pliegan con un clic en su título, como las secciones del menú de
// Mac; queda recordado en el navegador.

const items: InboxItem[] = [
  item({ ref: 'acme/api#1', title: 'Primera' }),
  item({ ref: 'acme/api#2', title: 'Segunda', kind: 'prd', actions: ['approve_prd'] }),
]
vi.mock('@/features/inbox/api', () => ({
  getInbox: async () => ({ generated_at: 'x', projects: [], items }),
  getTasks: async () => null,
  getTaskDetail: vi.fn(),
  postTaskAction: vi.fn(),
}))
vi.mock('@/features/inbox/stream', () => ({ connectRunnerStream: () => ({ close: vi.fn() }) }))
vi.mock('@/composables/useServerTarget', () => ({
  serverTarget: () => ({ base: 'https://runner.test', url: (p: string) => p }),
}))

import MineBoard from '@/features/inbox/MineBoard.vue'
import { useInboxStore } from '@/features/inbox/store'

async function render() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const w = mount(MineBoard, { global: { plugins: [pinia], stubs: ['RouterLink'] } })
  const store = useInboxStore()
  store.start()
  await flushPromises()
  return { w, store }
}

beforeEach(() => localStorage.clear())

describe('plegar «Lo primero» y «Después»', () => {
  it('«Lo primero» plegado deja el título de la tarea y esconde su botón; se recuerda', async () => {
    const { w, store } = await render()
    const fold = w.get('[data-test="first-fold"]')
    expect(fold.attributes('aria-expanded')).toBe('true')
    await fold.trigger('click')
    expect(w.get('[data-test="first-fold"]').attributes('aria-expanded')).toBe('false')
    expect(w.get('.fd').classes()).toContain('fd--folded')
    expect(w.get('.fd__peek').text()).toBe('Primera')
    await flushPromises()
    expect(localStorage.getItem('ia-flow:collapsed:first')).toBe('1')
    store.stop()
    w.unmount()

    const again = await render()
    expect(again.w.get('.fd').classes()).toContain('fd--folded')
    again.store.stop()
    again.w.unmount()
  })

  it('«Después» plegado esconde sus filas', async () => {
    const { w, store } = await render()
    expect(w.get('#after-list').isVisible()).toBe(true)
    await w.get('[data-test="after-fold"]').trigger('click')
    expect(w.get('#after-list').attributes('style')).toContain('display: none')
    expect(w.get('[data-test="after-fold"]').attributes('aria-expanded')).toBe('false')
    store.stop()
    w.unmount()
  })
})
