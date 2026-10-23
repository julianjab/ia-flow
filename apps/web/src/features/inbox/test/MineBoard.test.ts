import type { InboxItem } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { item } from '@/features/inbox/test/fixtures'

// «Para mí»: el orden que se elige, las pospuestas plegadas al final y su «Deshacer».

const items: InboxItem[] = [
  item({ ref: 'acme/api#1', title: 'Vieja', since: '2026-01-01T10:00:00.000Z' }),
  item({
    ref: 'acme/api#2',
    title: 'Nueva',
    kind: 'prd',
    actions: ['approve_prd'],
    since: '2026-01-04T10:00:00.000Z',
  }),
  item({
    ref: 'acme/api#3',
    title: 'Del medio',
    kind: 'doubt',
    actions: ['answer_and_unblock'],
    since: '2026-01-02T10:00:00.000Z',
  }),
]
vi.mock('@/features/inbox/api', () => ({
  getInbox: async () => ({
    generated_at: '2026-01-05T10:00:00.000Z',
    projects: [{ id: 'core', board: { owner: 'acme', number: 1 } }],
    items,
  }),
  getTasks: async () => null,
  getTaskDetail: vi.fn(),
  getBoardRest: vi.fn(),
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

type Wrapper = Awaited<ReturnType<typeof render>>['w']

/** El título de «Lo primero» y los de las filas, en el orden en que se dibujan. */
const order = (w: Wrapper) => [
  w.get('[data-test="first"] .fd__title').text(),
  ...w.findAll('.dr__title').map((t) => t.text()),
]

/** Lo que quedó guardado para este runner (la clave la arma `serverKey`). */
function saved() {
  const key = Object.keys(localStorage).find((k) => k.startsWith('ia-flow:arrange:')) ?? ''
  return JSON.parse(localStorage.getItem(key) ?? '{}')
}

beforeEach(() => localStorage.clear())

describe('MineBoard', () => {
  it('«Más reciente» y «Más antigua» reordenan por fecha; se recuerda por runner', async () => {
    const { w, store } = await render()
    expect(order(w)).toEqual(['Vieja', 'Nueva', 'Del medio'])
    await w.get('[data-test="sort-recent"]').trigger('click')
    expect(order(w)).toEqual(['Nueva', 'Del medio', 'Vieja'])
    await w.get('[data-test="sort-oldest"]').trigger('click')
    expect(order(w)).toEqual(['Vieja', 'Del medio', 'Nueva'])
    await flushPromises()
    expect(saved().sort).toBe('oldest')
    store.stop()
    w.unmount()
  })

  it('una pospuesta sale de la cola y del contador, queda en «Pospuestas» y se puede deshacer', async () => {
    const { w, store } = await render()
    store.snooze(items[0] as InboxItem, null)
    await flushPromises()
    expect(order(w)).not.toContain('Vieja')
    expect(store.queue.headline.decisions).toBe(2)
    expect(w.text()).toContain('Pospuestas · 1')
    await w.get('[data-test="undo-snooze"]').trigger('click')
    expect(order(w)).toContain('Vieja')
    store.stop()
    w.unmount()
  })

  it('una fijada va primero con cualquier orden', async () => {
    const { w, store } = await render()
    store.togglePin('acme/api#3')
    await w.get('[data-test="sort-recent"]').trigger('click')
    expect(order(w)[0]).toBe('Del medio')
    store.stop()
    w.unmount()
  })
})
