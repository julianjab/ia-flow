import type { BoardRest as Rest } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getBoardRest = vi.fn()
const getTaskDetail = vi.fn()
const getClosedCards = vi.fn()
vi.mock('@/features/inbox/api', () => ({
  getInbox: vi.fn(),
  getBoardRest: (...a: unknown[]) => getBoardRest(...a),
  getTaskDetail: (...a: unknown[]) => getTaskDetail(...a),
  getClosedCards: (...a: unknown[]) => getClosedCards(...a),
  postTaskAction: vi.fn(),
}))

import BoardRest from '@/features/inbox/BoardRest.vue'
import { useInboxStore } from '@/features/inbox/store'

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
  const details = w.get('details').element as HTMLDetailsElement
  details.open = true
  await w.get('details').trigger('toggle')
  await flushPromises()
}

describe('BoardRest', () => {
  beforeEach(() => {
    getBoardRest.mockReset().mockResolvedValue(rest)
    getTaskDetail.mockReset().mockResolvedValue({ item: {}, executions: [], events: [], trace: [] })
  })

  it('plegado, la línea de resumen ya dice la cuenta por columna (se pide al montar)', async () => {
    const w = render()
    await flushPromises()
    expect(getBoardRest).toHaveBeenCalledOnce()
    expect(w.get('details').attributes('open')).toBeUndefined()
    const sum = w.get('summary')
    expect(w.get('h2').text()).toBe('Resto del board')
    expect(sum.find('h2').exists()).toBe(false)
    expect(sum.text()).toContain('Resto del board')
    expect(sum.text()).toContain('3 cards · Backlog 1 · Todo 2')
  })

  it('cada fila abre el detalle y lleva su link corto a GitHub, fuera del botón', async () => {
    const w = render()
    await openIt(w)
    const link = w.get('a[href="https://github.com/o/r#3"]')
    expect(link.text()).toBe('r#3 ↗')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.element.closest('button')).toBeNull()
  })

  it('si el board no llega, lo dice con qué hacer y deja reintentar', async () => {
    getBoardRest.mockReset().mockRejectedValueOnce(new Error('El runner respondió 502'))
    getBoardRest.mockResolvedValueOnce(rest)
    const w = render()
    await openIt(w)
    const alert = w.get('[role="alert"]')
    expect(alert.text()).toContain('✕ No se pudo leer el board: El runner respondió 502')
    expect(alert.text()).toContain('→')
    await alert.get('button').trigger('click')
    await flushPromises()
    expect(w.find('[role="alert"]').exists()).toBe(false)
    expect(w.get('summary').text()).toContain('3 cards')
  })

  it('una card se abre en grande', async () => {
    const w = render()
    await openIt(w)
    await w.get('[data-test="rest-o/r#1"]').trigger('click')
    const store = useInboxStore()
    expect(store.openRef).toBe('o/r#1')
    expect(store.expanded).toBe(true)
  })

  it('«Cerrados» se pide recién al abrirlo y cada uno se abre en GitHub', async () => {
    getBoardRest.mockResolvedValue(rest)
    getClosedCards.mockResolvedValue([
      { ...row('o/r#9', 'Done'), closed_at: '2026-09-29T10:00:00Z' },
    ])
    const w = render()
    await flushPromises()
    expect(getClosedCards).not.toHaveBeenCalled()
    const closed = w.get('[data-test="closed"] details')
    ;(closed.element as HTMLDetailsElement).open = true
    await closed.trigger('toggle')
    await flushPromises()
    expect(getClosedCards).toHaveBeenCalledTimes(1)
    const item = w.get('[data-test="closed-o/r#9"]')
    expect(item.text()).toContain('título o/r#9')
    expect(item.text()).toContain('Done · cerrada')
    expect(item.get('a.br__row').attributes('href')).toBe('https://github.com/o/r#9')
  })
})
