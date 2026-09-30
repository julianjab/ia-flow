import type { BoardRest as Rest } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getBoardRest = vi.fn()
const getTaskDetail = vi.fn()
vi.mock('@/features/inbox/api', () => ({
  getInbox: vi.fn(),
  getBoardRest: (...a: unknown[]) => getBoardRest(...a),
  getTaskDetail: (...a: unknown[]) => getTaskDetail(...a),
  postTaskAction: vi.fn(),
}))

import BoardRest from '../BoardRest.vue'
import { useInboxStore } from '../store'

const row = (ref: string, status: string, foreign = false) => ({
  ref,
  project_id: 'p',
  title: `título ${ref}`,
  url: `https://github.com/${ref}`,
  status,
  labels: [],
  updated_at: '2026-09-30T10:00:00Z',
  foreign,
})
const rest: Rest = {
  columns: [
    { status: 'Backlog', items: [row('o/r#1', 'Backlog')] },
    { status: 'Todo', items: [row('o/r#2', 'Todo'), row('o/r#3', 'Todo', true)] },
  ],
}

function render() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(BoardRest, { global: { plugins: [pinia] } })
}

async function openIt(w: ReturnType<typeof render>) {
  const details = w.get('details.br').element as HTMLDetailsElement
  details.open = true
  await w.get('details.br').trigger('toggle')
  await flushPromises()
}

describe('BoardRest', () => {
  beforeEach(() => {
    getBoardRest.mockReset().mockResolvedValue(rest)
    getTaskDetail.mockReset().mockResolvedValue({ item: {}, executions: [], events: [], trace: [] })
  })

  it('no le pide nada al runner hasta que se abre', async () => {
    const w = render()
    expect(getBoardRest).not.toHaveBeenCalled()
    await openIt(w)
    expect(getBoardRest).toHaveBeenCalledOnce()
  })

  it('abierto, cuenta por columna y deja afuera las de otros engines hasta que se piden', async () => {
    const w = render()
    await openIt(w)
    expect(w.get('summary').text()).toContain('2 cards · Backlog 1 · Todo 1')
    expect(w.text()).not.toContain('o/r#3')
    await w.get('[data-test="foreign"]').trigger('click')
    expect(w.get('summary').text()).toContain('3 cards')
    // La de otro engine se abre en GitHub: este runner no la toca.
    expect(w.find('a.br__row').attributes('href')).toBe('https://github.com/o/r#3')
  })

  it('una card propia se abre en grande', async () => {
    const w = render()
    await openIt(w)
    await w.get('[data-test="rest-o/r#1"]').trigger('click')
    const store = useInboxStore()
    expect(store.openRef).toBe('o/r#1')
    expect(store.expanded).toBe(true)
  })
})
