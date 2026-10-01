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

const row = (ref: string, status: string) => ({
  ref,
  project_id: 'p',
  title: `título ${ref}`,
  url: `https://github.com/${ref}`,
  status,
  labels: [],
  updated_at: '2026-09-30T10:00:00Z',
})
const rest: Rest = {
  columns: [
    { status: 'Backlog', items: [row('o/r#1', 'Backlog')] },
    { status: 'Todo', items: [row('o/r#2', 'Todo'), row('o/r#3', 'Todo')] },
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

  it('abierto, cuenta por columna todas las cards del board', async () => {
    const w = render()
    await openIt(w)
    expect(w.get('summary').text()).toContain('3 cards · Backlog 1 · Todo 2')
    expect(w.text()).toContain('o/r#3')
  })

  it('una card se abre en grande', async () => {
    const w = render()
    await openIt(w)
    await w.get('[data-test="rest-o/r#1"]').trigger('click')
    const store = useInboxStore()
    expect(store.openRef).toBe('o/r#1')
    expect(store.expanded).toBe(true)
  })
})
