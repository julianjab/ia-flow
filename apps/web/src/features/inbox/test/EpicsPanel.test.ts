import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import EpicsPanel from '@/features/inbox/pipeline/EpicsPanel.vue'
import type { EpicLine } from '@/features/inbox/queue/epics'
import { useInboxStore } from '@/features/inbox/store'

vi.mock('@/features/inbox/api', () => ({ getEpic: () => new Promise(() => {}) }))

let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

const mountPanel = (props: { epics: EpicLine[]; folded?: boolean }) =>
  mount(EpicsPanel, { props, global: { plugins: [pinia] } })

const line = (over: Partial<EpicLine> = {}): EpicLine => ({
  ref: 'la-haus/subscriptions#1100',
  title: 'Calidad de leads',
  url: 'https://github.com/la-haus/subscriptions/issues/1100',
  done: 2,
  total: 6,
  pct: 33,
  neck: '#1179 espera tu respuesta',
  blockedAt: 'la-haus/subscriptions#1179',
  ...over,
})

describe('EpicsPanel', () => {
  it('cada épica: nombre que la abre con sus sub-issues, done/total, la barra decorativa y qué la traba', async () => {
    const w = mountPanel({ epics: [line(), line({ ref: 'x/y#2', title: 'Pagos', pct: 25 })] })
    const items = w.findAll('li')
    expect(items).toHaveLength(2)
    const open = items[0]!.get('[data-test="epic-open"]')
    expect(open.text()).toBe('Calidad de leads')
    // `.link`: el hover no es el video inverso global (que dejaba un bloque verde sin texto), y
    // el título completo va en el `title` porque el nombre se recorta a dos líneas.
    expect(open.classes()).toContain('link')
    expect(open.attributes('title')).toBe('Calidad de leads')
    await open.trigger('click')
    expect(useInboxStore().epicRef).toBe('la-haus/subscriptions#1100')
    expect(items[0]!.get('.mono').text()).toBe('2/6')
    const bar = items[0]!.get('[aria-hidden="true"]')
    expect(bar.get('div').attributes('style')).toContain('width: 33%')
    expect(items[0]!.get('[data-test="epic-neck"]').text()).toBe('#1179 espera tu respuesta')
    expect(items[1]!.text()).toContain('Pagos')
  })

  it('no se abre si la épica no tiene url (su ref no es `owner/repo#n`)', () => {
    const { url: _url, ...noUrl } = line()
    const w = mountPanel({ epics: [noUrl] })
    expect(w.find('[data-test="epic-open"]').exists()).toBe(false)
    expect(w.text()).toContain('Calidad de leads')
  })

  it('plegada: un <details> cerrado «Épicas» con cuántas están trabadas en vos', () => {
    const w = mountPanel({ epics: [line(), line({ ref: 'x/y#2' })], folded: true })
    const details = w.get('details')
    expect(details.attributes('open')).toBeUndefined()
    expect(details.get('summary').text()).toContain('Épicas')
    expect(w.get('[data-test="epics-stuck"]').text()).toBe('2 trabadas en vos')
  })

  it('sin épicas no se dibuja', () => {
    expect(mountPanel({ epics: [] }).find('[data-test="epics"]').exists()).toBe(false)
    expect(mountPanel({ epics: [], folded: true }).find('details').exists()).toBe(false)
  })
})
