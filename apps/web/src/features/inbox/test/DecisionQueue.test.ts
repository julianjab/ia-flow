import type { InboxItem } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { item } from '@/features/inbox/test/fixtures'

vi.mock('@/features/inbox/api', () => ({
  getInbox: vi.fn(),
  getTasks: vi.fn(),
  getTaskDetail: vi.fn(),
  postTaskAction: vi.fn(),
}))

import DecisionQueue from '@/features/inbox/decisions/DecisionQueue.vue'
import { buildQueue } from '@/features/inbox/queue/build'
import type { QueueType } from '@/features/inbox/queue/kinds'

const NOW = Date.parse('2026-01-02T10:00:00.000Z')
const decision = (n: number, over: Partial<InboxItem>) => item({ ref: `acme/api#${n}`, ...over })
const items = [
  decision(1, { kind: 'prd', actions: ['approve_prd'] }),
  decision(2, { kind: 'stale', actions: ['relaunch'] }),
  decision(3, { kind: 'doubt', actions: ['answer_and_unblock'] }),
  decision(4, { kind: 'stale', actions: ['relaunch'] }),
  decision(5, { group: 'fail', kind: 'crash', actions: ['retry'] }),
]

function render(list: InboxItem[], filter: QueueType | null = null) {
  setActivePinia(createPinia())
  const queue = buildQueue({ items: list, filter, now: NOW })
  return mount(DecisionQueue, {
    props: { rows: queue.rest, total: queue.restTotal, filters: queue.filters },
  })
}

describe('DecisionQueue', () => {
  it('encabezado «Después · K más» y filas numeradas desde el 2', () => {
    const w = render(items)
    expect(w.get('h2').text()).toBe('Después')
    expect(w.text()).toContain('4 más')
    expect(w.findAll('.dr__rank').map((r) => r.text())).toEqual(['2', '3', '4', '5'])
  })

  it('con más de 4 decisiones ofrece el filtro por tipo, con conteo y aria-pressed', async () => {
    const w = render(items)
    const toolbar = w.get('[role="toolbar"]')
    expect(toolbar.attributes('aria-label')).toBe('Filtrar por tipo')
    const chips = toolbar.findAll('button')
    expect(chips.map((c) => c.text())).toEqual([
      'Todas 4',
      'Responder 1',
      'Relanzar 2',
      'Reintentar 1',
    ])
    expect(chips[0]?.attributes('aria-pressed')).toBe('true')
    await chips[2]?.trigger('click')
    expect(w.emitted('filter')?.[0]).toEqual(['relaunch'])
  })

  it('filtrado: sólo ese tipo, sin renumerar, y el chip queda presionado', () => {
    const w = render(items, 'relaunch')
    expect(w.findAll('.dr__rank').map((r) => r.text())).toEqual(['2', '4'])
    expect(w.get('[data-type="relaunch"]').attributes('aria-pressed')).toBe('true')
  })

  it('con 4 decisiones o menos no hay filtro', () => {
    expect(render(items.slice(0, 4)).find('[role="toolbar"]').exists()).toBe(false)
  })

  it('el tono va por TIPO en el verbo, no por grupo', () => {
    const w = render(items)
    const tones = w.findAll('.dr').map((r) => [r.attributes('data-type'), r.attributes('style')])
    expect(tones).toEqual([
      ['relaunch', '--tone: var(--warn);'],
      ['answer', '--tone: var(--warn);'],
      ['relaunch', '--tone: var(--warn);'],
      ['fail', '--tone: var(--danger);'],
    ])
  })
})
